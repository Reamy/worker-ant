/**
 * zx_20261110_1 B3「协」受控回归 —— 两条派发路与项目 `dispatch_mode` 同一把尺。
 *
 * 病根：建单即派只问"开关/档位/入网/六类排除/形态"，从不看项目自己设的 `off`；
 *   调度器的 overflow / capability 两路又不把项目分工（候选白名单 + 权重倍率）随单交给 ANS——
 *   于是"用户在项目里点了几台机器"与"引擎实际派给谁"是两本账。
 *
 * A 建单路：项目显式 `off` ⇒ 最先拒（`project-mode-off`），不触网、不派、理由可读；反证不误拦。
 * B 调度器路：项目 `off` ⇒ 本拍 `continue`，零次提交（同一库改成 overflow 即派，证明差别只在闸）。
 * C 溢出路：项目有分工 ⇒ 提交体带 `dispatch_policy`（候选白名单 + 倍率，走唯一转换点）。
 * D 能力路：候选池先按分工收窄（白名单外的更强对端也不参选）；反证无分工时仍走全局池。
 * E 反证：无分工、未设 off ⇒ 建单派发与此前一致（不带 `dispatch_policy`）。
 * F 静态接线：两处 policy 真传、建单路真读项目模式、理由人话在册。
 * G build 钉（P1–P5）与方向性比较。
 *
 * 纪律：零网络 / 零 electron / 零墙钟（now 注入）；断言文案不含失败字形（汇总器按字形计数）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  CREATE_DISPATCH_REASON_LABEL,
  buildExistingTaskDispatchFacts,
  decideCreateDispatch,
  dispatchCreatedTask,
  projectDispatchOff,
  type CreateDispatchFacts,
} from '../apps/worker-ant-desktop/src/main/core/collab-dispatch.js';
import { driveOrchestration } from '../apps/worker-ant-desktop/src/main/core/orchestrator.js';
import { PROJECT_NODES_DDL } from '../apps/worker-ant-desktop/src/main/core/project-node-policy.js';
import type { DispatchIo } from '../apps/worker-ant-desktop/src/main/core/node-dispatcher.js';
import type { AnsNode, AnsNodeRequest } from '@worker-ant/shared-types';
import { buildNotOlderThan, checkBuildPins, deriveBuildTag } from './lib/rr-pins.js';

const SELF_ROUND = /^rr_(zx_\d{8}(?:_\d+)?)/.exec(path.basename(__filename, '.ts'))?.[1] ?? '';
const ROOT = path.join(__dirname, '..');
const DESKTOP = path.join(ROOT, 'apps/worker-ant-desktop');
const NOW = Date.parse('2026-11-10T00:00:00.000Z');
const dbTime = (ms: number): string => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  PASS ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (actual: unknown, expect: unknown, label: string) =>
  ok(JSON.stringify(actual) === JSON.stringify(expect), label, `${JSON.stringify(actual)} vs ${JSON.stringify(expect)}`);

/* ── 夹具：列形照生产；项目分工表引生产同一份 DDL ─────────────────────── */

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

/** 设备表按生产列形（`listDevices` 读全列；最小形状会因缺列抛错、把能力画像误判成"建不起来"）。 */
const DEVICES_DDL = `CREATE TABLE wa_devices (
  id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', alias TEXT NOT NULL DEFAULT '', room TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'unknown', kind_class TEXT NOT NULL DEFAULT '', protocol TEXT NOT NULL DEFAULT 'mdns',
  address TEXT NOT NULL DEFAULT '', port INTEGER, capabilities_json TEXT NOT NULL DEFAULT '[]',
  controllable INTEGER NOT NULL DEFAULT 0, authorized INTEGER NOT NULL DEFAULT 0, status_json TEXT,
  desired_json TEXT, online INTEGER, first_seen TEXT NOT NULL DEFAULT '', last_seen TEXT NOT NULL DEFAULT ''
)`;

/** 已入网 + 试用（⇒ 团队版）+ 非占位凭据；角色 primary 才能派活。 */
function baseDb(opts: { withDevices?: boolean } = {}): DatabaseSync {
  const d = new DatabaseSync(':memory:');
  d.exec(SCHEMA);
  if (opts.withDevices !== false) d.exec(DEVICES_DDL);
  d.exec(PROJECT_NODES_DDL);
  const ins = d.prepare('INSERT INTO wa_settings (key, value) VALUES (?, ?)');
  ins.run('node.id', 'n-self');
  ins.run('node.resource_group', 'node:n-self');
  ins.run('node.role', 'primary');
  ins.run('ans_api_key', 'wa_rr_enrolled_key'); //gitleaks:allow
  ins.run('node.orchestrate_mode', 'overflow');
  ins.run('license.trial_started_at', new Date(NOW).toISOString());
  return d;
}

const asBetter = (d: DatabaseSync) => d as unknown as import('better-sqlite3').Database;

function addProject(d: DatabaseSync, id: string, context: Record<string, unknown>): void {
  d.prepare("INSERT INTO wa_projects (id, status, context_json) VALUES (?, 'active', ?)")
    .run(id, JSON.stringify(context));
}

function addTask(
  d: DatabaseSync,
  id: string,
  projectId: string,
  status = 'pending',
  title = '实现一个导出脚本',
): void {
  d.prepare('INSERT INTO wa_tasks (id, project_id, title, description, status, context_json) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, projectId, title, '', status, JSON.stringify({ goal: { text: '导出' } }));
}

function addDivision(d: DatabaseSync, projectId: string, nodeId: string, weight = 1, participate = 1): void {
  d.prepare('INSERT INTO wa_project_nodes (project_id, node_id, participate, weight) VALUES (?, ?, ?, ?)')
    .run(projectId, nodeId, participate, weight);
}

/** 台账行真形状；只改要验的那几项。 */
function ansNode(nodeId: string, over: Partial<AnsNode> = {}): AnsNode {
  return {
    node_id: nodeId,
    name: nodeId,
    api_key_prefix: '',
    resource_group: `node:${nodeId}`,
    platform: 'darwin/arm64',
    role: 'worker',
    weight: 5,
    participate: true,
    capabilities: [],
    card: { categories: ['code'], intents: [], device_categories: [] },
    status: { machine_limit: 4, free_slots: 4, running_tasks: 0 },
    enrolled_at: '2026-11-01 00:00:00',
    last_seen_at: dbTime(NOW),
    ...over,
  };
}

function ansRequest(over: Partial<AnsNodeRequest> = {}): AnsNodeRequest {
  return {
    id: 'rq-b3', category: 'code', payload: {}, requester_key_prefix: 'rr00',
    requester_node_id: 'n-self', target_node_id: 'n-peer', status: 'assigned', result: null,
    question: null, answer: null, question_status: null, selection: null, progress: null,
    cancel_requested: false, created_at: dbTime(NOW), claimed_at: null, done_at: null,
    ...over,
  };
}

/** 假派发 IO：只记录提交体，不触网。 */
function fakeDispatchIo(): { io: DispatchIo; submits: Array<Record<string, unknown>> } {
  const submits: Array<Record<string, unknown>> = [];
  const io: DispatchIo = {
    async submit(req) {
      submits.push(req as unknown as Record<string, unknown>);
      return ansRequest({ id: `rq-b3-${submits.length}`, category: req.category, target_node_id: req.target_node_id ?? 'n-peer' });
    },
    async get() { return ansRequest(); },
    async answer() { return ansRequest(); },
    async cancel() { return ansRequest(); },
  };
  return { io, submits };
}

/** 建单准入事实（全部通过的一套；只改要验的那一项）。 */
const eligibleFacts = (over: Partial<CreateDispatchFacts> = {}): CreateDispatchFacts => ({
  settingOn: true,
  autoDispatchSource: 'explicit',
  localHasFreeSlot: true,
  teamUnlocked: true,
  enrolled: true,
  hasDependencies: false,
  hasAttachments: false,
  hasWorkingDir: false,
  decomposed: false,
  category: 'code',
  ...over,
});

/* ── A 建单路：项目 off 最先拒 ─────────────────────────────────────── */

async function sectionA(): Promise<void> {
  console.log('\n【A】建单路：项目显式 off 最先拒（不触网）');
  eq(decideCreateDispatch(eligibleFacts({ projectDispatchOff: true })).reason, 'project-mode-off',
    'A-1 项目显式关闭外派 ⇒ 理由 project-mode-off');
  ok(CREATE_DISPATCH_REASON_LABEL['project-mode-off'].includes('项目已关闭外派'),
    'A-2 理由有人话（界面直接上屏）', CREATE_DISPATCH_REASON_LABEL['project-mode-off']);
  eq(decideCreateDispatch(eligibleFacts({ projectDispatchOff: true, settingOn: false })).reason, 'project-mode-off',
    'A-3 排在开关之前：项目级关闭比全局开关更具体（最上游）');
  eq(decideCreateDispatch(eligibleFacts({ projectDispatchOff: true, category: null })).reason, 'project-mode-off',
    'A-4 排在形态判据之前：关了就是关了，不拿"形态不明"当理由');
  eq(decideCreateDispatch(eligibleFacts()).reason, 'eligible',
    'A-5 反证：未传该项（旧调用方）行为不变');

  // 库现读：显式 off 为真、其它值/缺行不拦
  {
    const d = baseDb();
    addProject(d, 'p-off', { dispatch_mode: 'off' });
    addProject(d, 'p-auto', { dispatch_mode: 'overflow' });
    addProject(d, 'p-legacy', { dispatch_mode: 'auto' });
    addProject(d, 'p-none', {});
    eq(projectDispatchOff(asBetter(d), 'p-off'), true, 'A-6 库现读：显式 off 命中');
    eq(projectDispatchOff(asBetter(d), 'p-auto'), false, 'A-7 反证：overflow 不拦');
    eq(projectDispatchOff(asBetter(d), 'p-legacy'), false, 'A-8 反证：旧值 auto 不是 off');
    eq(projectDispatchOff(asBetter(d), 'p-none'), false, 'A-9 反证：未设置不拦');
    eq(projectDispatchOff(asBetter(d), 'p-missing'), false, 'A-10 反证：项目行不存在不拦（读不到不当有值）');
  }

  // 端到端：真 `dispatchCreatedTask`，项目 off ⇒ 零次提交
  {
    const d = baseDb();
    addProject(d, 'p-off', { dispatch_mode: 'off' });
    addTask(d, 't-off', 'p-off');
    const { io, submits } = fakeDispatchIo();
    const ledger = { localNodeId: 'n-self', nodes: [ansNode('n-self'), ansNode('n-peer')] };
    const out = await dispatchCreatedTask(asBetter(d), { id: 't-off', title: '实现一个导出脚本' }, eligibleFacts(), {
      listLedger: async () => ledger,
      io,
      emit: () => true,
      nowMs: NOW,
    });
    eq(out.reason, 'project-mode-off', 'A-11 建单路径如实回 project-mode-off');
    eq(out.attempted, false, 'A-12 没触网（attempted=false）');
    eq(submits.length, 0, 'A-13 零次提交（0 就是 0）');
    eq(buildExistingTaskDispatchFacts(asBetter(d), 't-off').projectDispatchOff, true,
      'A-14 任务详情的「派单理由」读同一事实（同一把尺）');
  }
}

/* ── B 调度器路：项目 off ⇒ 本拍 continue ─────────────────────────── */

function readyRow(): Array<Record<string, unknown>> {
  return [{ id: 't1', title: '实现一个导出脚本', description: '', context_json: JSON.stringify({ goal: { text: '导出' } }) }];
}

async function sectionB(): Promise<void> {
  console.log('\n【B】调度器路：项目 off 一拍也不扫');
  const offDb = baseDb();
  addProject(offDb, 'p-off', { dispatch_mode: 'off', rhythm: { maxConcurrency: 1 } });
  addTask(offDb, 't1', 'p-off');
  addTask(offDb, 't-run', 'p-off', 'executing'); // 本机占满（若闸失效会真派）
  const offIo = fakeDispatchIo();
  const offRes = await driveOrchestration(asBetter(offDb), {
    io: offIo.io,
    emit: () => true,
    listPeers: async () => [ansNode('n-peer')],
    readyTasks: () => readyRow(),
    teamRefusal: () => null,
    now: () => NOW,
    cooldownUntil: new Map(),
  });
  eq(offIo.submits.length, 0, 'B-1 项目 off ⇒ 零次派发提交');
  eq(offRes.offloaded, 0, 'B-2 派出件数为 0（不谎称派了）');

  // 反证：同一库只把项目模式改成 overflow ⇒ 立即真派（差别只在闸）
  const onDb = baseDb();
  addProject(onDb, 'p-on', { dispatch_mode: 'overflow', rhythm: { maxConcurrency: 1 } });
  addTask(onDb, 't1', 'p-on');
  addTask(onDb, 't-run', 'p-on', 'executing');
  const onIo = fakeDispatchIo();
  const onRes = await driveOrchestration(asBetter(onDb), {
    io: onIo.io,
    emit: () => true,
    listPeers: async () => [ansNode('n-peer')],
    readyTasks: () => readyRow(),
    teamRefusal: () => null,
    now: () => NOW,
    cooldownUntil: new Map(),
  });
  eq(onIo.submits.length, 1, 'B-3 反证：改成 overflow 后恰派一次（闸真在起作用）');
  eq(onRes.offloaded, 1, 'B-4 反证：派出件数为 1');
}

/* ── C 溢出路：项目分工随单交出 ───────────────────────────────────── */

async function sectionC(): Promise<void> {
  console.log('\n【C】溢出路：有分工 ⇒ 提交体带 dispatch_policy');
  const d = baseDb();
  addProject(d, 'p-div', { dispatch_mode: 'overflow', rhythm: { maxConcurrency: 1 } });
  addTask(d, 't1', 'p-div');
  addTask(d, 't-run', 'p-div', 'executing');
  addDivision(d, 'p-div', 'n-peer', 3);
  const { io, submits } = fakeDispatchIo();
  const res = await driveOrchestration(asBetter(d), {
    io,
    emit: () => true,
    listPeers: async () => [ansNode('n-peer')],
    readyTasks: () => readyRow(),
    teamRefusal: () => null,
    now: () => NOW,
    cooldownUntil: new Map(),
  });
  eq(res.offloaded, 1, 'C-1 溢出件真派出');
  eq(submits.length, 1, 'C-2 恰一次提交（0→1 正面计数）');
  eq(submits[0]?.dispatch_policy, { candidate_node_ids: ['n-peer'], weight_scale: { 'n-peer': 3 } },
    'C-3 项目分工原样进入提交体（候选 + 倍率，走唯一转换点）');
  eq(submits[0]?.require_target, true, 'C-4 自动外派仍要求确定目标（无合格对端不落悬空单）');
  ok(!('target_node_id' in (submits[0] ?? {})), 'C-5 溢出路仍交给 ANS 在候选内选人（本地不越权指定）');
}

/* ── D 能力路：候选池先收窄 ───────────────────────────────────────── */

async function sectionD(): Promise<void> {
  console.log('\n【D】能力路：候选池先按项目分工收窄');

  // 两台对端都强于本机（本机权重 5、能力路要求 margin ≥0.12）：n-alt 余力更足（满格），
  //   但项目里登记为退出（participate=0）⇒ 收窄后只能选 n-peer（半格余力）。
  //   注：权重按 1..10 归一（>10 一律当 10），两台同权重则同分——故用余力区分强弱。
  const peers = [
    ansNode('n-peer', { weight: 10, status: { machine_limit: 4, free_slots: 2, running_tasks: 2 } }),
    ansNode('n-alt', { weight: 10, status: { machine_limit: 4, free_slots: 4, running_tasks: 0 } }),
  ];

  const narrowedDb = baseDb();
  addProject(narrowedDb, 'p-cap', { dispatch_mode: 'capability', rhythm: { maxConcurrency: 2 } });
  addTask(narrowedDb, 't1', 'p-cap');
  addDivision(narrowedDb, 'p-cap', 'n-peer', 5);
  addDivision(narrowedDb, 'p-cap', 'n-alt', 5, 0);
  const narrowedIo = fakeDispatchIo();
  const narrowed = await driveOrchestration(asBetter(narrowedDb), {
    io: narrowedIo.io,
    emit: () => true,
    listPeers: async () => peers,
    readyTasks: () => readyRow(),
    teamRefusal: () => null,
    now: () => NOW,
    cooldownUntil: new Map(),
  });
  eq(narrowed.offloaded, 1, 'D-1 收窄后仍能派出（不把活卡死）');
  eq(narrowedIo.submits[0]?.target_node_id, 'n-peer', 'D-2 白名单外的更强对端不参选');
  eq((narrowedIo.submits[0]?.dispatch_policy as { candidate_node_ids?: unknown })?.candidate_node_ids, ['n-peer'],
    'D-3 提交体白名单与项目分工一致（n-alt 已退出）');

  // 反证：同一组对端、项目未登记分工 ⇒ 回到全局池，更强的 n-alt 当选。
  const globalDb = baseDb();
  addProject(globalDb, 'p-cap2', { dispatch_mode: 'capability', rhythm: { maxConcurrency: 2 } });
  addTask(globalDb, 't1', 'p-cap2');
  const globalIo = fakeDispatchIo();
  const globalRes = await driveOrchestration(asBetter(globalDb), {
    io: globalIo.io,
    emit: () => true,
    listPeers: async () => peers,
    readyTasks: () => readyRow(),
    teamRefusal: () => null,
    now: () => NOW,
    cooldownUntil: new Map(),
  });
  eq(globalRes.offloaded, 1, 'D-4 反证：无分工照常派出');
  eq(globalIo.submits[0]?.target_node_id, 'n-alt', 'D-5 反证：无分工时按全局池选更强对端（收窄非副作用）');
  ok(!('dispatch_policy' in (globalIo.submits[0] ?? {})), 'D-6 反证：无分工不带 dispatch_policy');
}

/* ── E 反证：无分工、未设 off ⇒ 建单行为不变 ──────────────────────── */

async function sectionE(): Promise<void> {
  console.log('\n【E】反证：无分工、未设 off ⇒ 建单派发与旧行为一致');
  const d = baseDb();
  addProject(d, 'p-plain', {});
  addTask(d, 't1', 'p-plain');
  const { io, submits } = fakeDispatchIo();
  const ledger = { localNodeId: 'n-self', nodes: [ansNode('n-self'), ansNode('n-peer')] };
  const out = await dispatchCreatedTask(asBetter(d), { id: 't1', title: '实现一个导出脚本' }, eligibleFacts(), {
    listLedger: async () => ledger,
    io,
    emit: () => true,
    nowMs: NOW,
  });
  eq(out.ok, true, 'E-1 照常派出');
  eq(submits.length, 1, 'E-2 恰一次提交');
  ok(!('dispatch_policy' in (submits[0] ?? {})), 'E-3 无分工 ⇒ 不带 dispatch_policy（不制造空策略）');
}

/* ── F 静态接线：两处 policy 真传、建单路真读项目模式 ─────────────────── */

function sectionF(): void {
  console.log('\n【F】静态接线（只建文件不接不算完成）');
  const orch = fs.readFileSync(path.join(DESKTOP, 'src/main/core/orchestrator.ts'), 'utf-8');
  const collab = fs.readFileSync(path.join(DESKTOP, 'src/main/core/collab-dispatch.ts'), 'utf-8');
  const wireHits = [...orch.matchAll(/policy:\s*toWireDispatchPolicy\(/g)].length;
  ok(wireHits >= 2, 'F-1 编排器两条路都真传 policy（overflow + capability）', `实测 ${wireHits} 处`);
  ok(/projectTargeted\)\)\s*return\s+null/.test(orch) || orch.includes('const policyOf = (category: NodeCardCategory)'),
    'F-2 分工读取收在一处（policyOf），不各写一套');
  ok(/cap\.peerProfiles\.filter\(\(pp\) => allowed\.has\(pp\.nodeId\)\)/.test(orch),
    'F-3 能力候选池真按白名单过滤（不是只把 policy 传给 ANS）');
  ok(collab.includes('readProjectDispatchModeRaw'),
    'F-4 建单路从项目 context 真读 dispatch_mode（与调度器同源）');
  ok(/SELECT context_json FROM wa_projects WHERE id = \?/.test(collab),
    'F-5 项目模式按 id 现读（不靠调用方记着传）');
  ok(collab.includes("'project-mode-off': '项目已关闭外派（只在本机跑）'"),
    'F-6 理由人话在册（界面可读）');
  const gateIdx = collab.indexOf("if (f.projectDispatchOff === true) return deny('project-mode-off');");
  const settingIdx = collab.indexOf("if (!f.settingOn) return deny('setting-off');");
  ok(gateIdx > 0 && settingIdx > 0 && gateIdx < settingIdx,
    'F-7 项目关闸排在全局开关之前（最上游的那道闸）');

  const projSrc = fs.readFileSync(path.join(DESKTOP, 'src/main/ipc/project.ipc.ts'), 'utf-8');
  ok(projSrc.includes('await dispatchCreatedTask('),
    'F-8 建单 IPC 仍走同一派发编排（无第二套派发判据）');
}

/* ── G build 钉 ─────────────────────────────────────────────────── */

function sectionG(): void {
  console.log('\n【G】build 标识与方案在册');
  const { tag } = deriveBuildTag(fs.readFileSync(path.join(DESKTOP, 'src/main/core/agent-executor.ts'), 'utf-8'));
  ok(buildNotOlderThan(tag, SELF_ROUND), 'G-1 build 标识不早于脚本轮次（方向性派生）', `${tag} vs ${SELF_ROUND}`);
  checkBuildPins(ok, { rootDir: ROOT });
}

async function run(): Promise<void> {
  await sectionA();
  await sectionB();
  await sectionC();
  await sectionD();
  await sectionE();
  sectionF();
  sectionG();

  console.log(`\n${fail === 0 ? 'OK' : 'FAIL'} rr_${SELF_ROUND}: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
}

void run();
