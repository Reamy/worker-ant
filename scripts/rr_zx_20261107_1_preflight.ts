/**
 * zx_20261107_1 B5「实·通·信」受控回归 —— 拆解预检（孙子·不战而屈人之兵 / 毛选·不打无准备之仗）。
 *
 * 钉住五件事：
 *   A 四态裁定：`no-capable-node` / `budget-impossible` / `nodes-offline` / `ok`，次序先命中先报；
 *   B 未知不装已知：对端台账没读到 ⇒ 不判死（留旁注）；本机永远可执行（权重 0 不加罪）；
 *   C 环依赖**不**整批拒绝：落行仍按边丢、点名；预检只判能力/预算/可用性；
 *   D 预检不过 ⇒ `created===0` 且**零落行**（无半成品）；过了 ⇒ 结论随 `dispatch_requirements.preflight` 落库；
 *   E 洗形不连坐：预检坏只丢该字段，模型声明的三面坏才整块作废。
 *
 * 纪律：零网络 / 零 electron / 零时钟；阈值一律由 `MIN_SUBTASK_TOKENS` 等载体派生，
 *   不写「只为下一轮」的字面量。本脚本不调 `collectPreflightContext`（它会打节点台账网络）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  MIN_SUBTASK_TOKENS,
  runPreflight,
  toPreflightRecord,
  type PreflightContext,
  type PreflightNodeProfile,
} from '../apps/worker-ant-desktop/src/main/core/task-preflight.js';
import {
  planSubtasksFromTemplate,
  droppedDepsNotice,
  type DecompositionTemplate,
} from '../apps/worker-ant-desktop/src/main/core/task-decompose.js';
import {
  sanitizeDispatchRequirements,
  requirementsForTask,
  DISPATCH_REQUIREMENTS_KEY,
  type DispatchRequirements,
} from '../apps/worker-ant-desktop/src/main/core/task-capability.js';
import { buildNotOlderThan, checkBuildPins, deriveBuildTag, stripKeepingLines } from './lib/rr-pins.js';

const SELF_ROUND = /^rr_(zx_\d{8}(?:_\d+)?)/.exec(path.basename(__filename, '.ts'))?.[1] ?? '';
const ROOT = path.join(__dirname, '..');
const DESKTOP = path.join(ROOT, 'apps/worker-ant-desktop/src/main');

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  PASS ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (actual: unknown, expect: unknown, label: string) =>
  ok(JSON.stringify(actual) === JSON.stringify(expect), label, `${JSON.stringify(actual)} vs ${JSON.stringify(expect)}`);

// ═══ 单测夹具（纯函数，无库） ═════════════════════════════════════════════════
const node = (over: Partial<PreflightNodeProfile> = {}): PreflightNodeProfile => ({
  nodeId: 'peer-1', isLocal: false, online: true, weight: 5,
  categories: ['text'], intents: [], deviceClasses: [], ...over,
});
const local = (over: Partial<PreflightNodeProfile> = {}): PreflightNodeProfile =>
  node({ nodeId: 'local', isLocal: true, ...over });
const req = (over: Partial<DispatchRequirements> = {}): DispatchRequirements => ({
  categories: ['text'], intents: [], deviceClasses: [], confidence: 0.6, source: 'rule', ...over,
});
const sub = (title: string, requirements: DispatchRequirements, index = 1) => ({ index, title, requirements });
const ctxOf = (nodes: PreflightNodeProfile[], peersKnown = true, projectTokens: number | null = null): PreflightContext =>
  ({ nodes, peersKnown, budget: { projectTokens } });

// ═══ A｜四态裁定与次序 ═══════════════════════════════════════════════════════
function sectionA(): void {
  console.log('\n【A】四态裁定（能力 → 预算 → 可用 → ok）');

  const okRun = runPreflight({ ...ctxOf([local()]), subtasks: [sub('甲', req())] });
  eq([okRun.verdict, okRun.peersKnown, okRun.nodeCount], ['ok', true, 1], 'A1 有覆盖节点 ⇒ ok，判定数含本机');
  eq(okRun.notes, [], 'A2 台账读到且全过 ⇒ 无旁注（不刷存在感）');

  const noCap = runPreflight({ ...ctxOf([local()]), subtasks: [sub('乙', req({ categories: ['media'] }))] });
  eq(noCap.verdict, 'no-capable-node', 'A3 ★没有任何节点具备要求类目 ⇒ no-capable-node');
  ok((noCap.reason ?? '').includes('「乙」') && (noCap.reason ?? '').includes('类目:媒体'),
    'A4 拒因点名子任务与所缺能力（不只报个数）', noCap.reason);

  const tooSmall = runPreflight({
    ...ctxOf([local()], true, MIN_SUBTASK_TOKENS - 1),
    subtasks: [sub('甲', req())],
  });
  eq(tooSmall.verdict, 'budget-impossible', 'A5 ★项目级每任务预算低于最小原型 ⇒ budget-impossible');
  ok((tooSmall.reason ?? '').includes('conversation') && (tooSmall.reason ?? '').includes('触顶'),
    'A6 拒因写明阈值来源与后果', tooSmall.reason);

  const atFloor = runPreflight({
    ...ctxOf([local()], true, MIN_SUBTASK_TOKENS),
    subtasks: [sub('甲', req())],
  });
  eq(atFloor.verdict, 'ok', 'A7 **反证（恰等于下限）**：不比阈值更严，放行');
  const unset = runPreflight({ ...ctxOf([local()], true, null), subtasks: [sub('甲', req())] });
  eq(unset.verdict, 'ok', 'A8 项目预算未显式设置 ⇒ 不构成拒绝理由（子任务回落原型默认）');

  const offlinePeer = runPreflight({
    ...ctxOf([local({ categories: [] }), node({ online: false })]),
    subtasks: [sub('甲', req())],
  });
  eq(offlinePeer.verdict, 'nodes-offline', 'A9 ★唯一覆盖节点离线 ⇒ nodes-offline');
  ok((offlinePeer.reason ?? '').includes('离线'), 'A10 拒因逐台标注可用性', offlinePeer.reason);

  const zeroWeight = runPreflight({
    ...ctxOf([local({ categories: [] }), node({ weight: 0 })]),
    subtasks: [sub('甲', req())],
  });
  eq(zeroWeight.verdict, 'nodes-offline', 'A11 ★权重 0 与离线同处置（会做但派不到）');
  ok((zeroWeight.reason ?? '').includes('权重 0'), 'A12 拒因区分「权重 0」与「离线」', zeroWeight.reason);

  const onlineBack = runPreflight({
    ...ctxOf([local({ categories: [] }), node({ online: true, weight: 5 })]),
    subtasks: [sub('甲', req())],
  });
  eq(onlineBack.verdict, 'ok', 'A13 **反证（同一台在线且正权重）**：即可用');

  // 次序：能力关先于预算关（两者同时不满足时先报能力）。
  const both = runPreflight({
    ...ctxOf([local()], true, MIN_SUBTASK_TOKENS - 1),
    subtasks: [sub('乙', req({ categories: ['media'] }))],
  });
  eq(both.verdict, 'no-capable-node', 'A14 ★裁定次序：能力覆盖先于预算（先命中先报）');
}

// ═══ B｜未知不装已知 & 本机永远可执行 ═════════════════════════════════════════
function sectionB(): void {
  console.log('\n【B】未知不装已知；本机永远可执行');

  const unknownPeers = runPreflight({
    ...ctxOf([local()], false),
    subtasks: [sub('乙', req({ categories: ['media'] }))],
  });
  eq(unknownPeers.verdict, 'ok', 'B1 ★对端台账未读到 ⇒ 缺能力**不判死**（不知道 ≠ 没有）');
  ok(unknownPeers.notes.some((n) => n.includes('远端节点台账未读到')),
    'B2 但如实留旁注（缺口可能在对端）', unknownPeers.notes.join(' / '));

  const noNodes = runPreflight({ ...ctxOf([], true), subtasks: [sub('乙', req({ categories: ['media'] }))] });
  eq(noNodes.verdict, 'ok', 'B3 一个节点画像都没取到 ⇒ 不判死');
  ok(noNodes.notes.some((n) => n.includes('未判')), 'B4 旁注说清能力覆盖未判', noNodes.notes.join(' / '));

  const localZero = runPreflight({
    ...ctxOf([local({ weight: 0, categories: ['media'] })]),
    subtasks: [sub('乙', req({ categories: ['media'] }))],
  });
  eq(localZero.verdict, 'ok', 'B5 ★本机权重 0 ⇒ 仍可执行（0 只关协同外派，不关本机跑活）');
  const localOffline = runPreflight({
    ...ctxOf([local({ online: false, categories: ['media'] })]),
    subtasks: [sub('乙', req({ categories: ['media'] }))],
  });
  eq(localOffline.verdict, 'ok', 'B6 ★本机 online=false（形状异常）也不拦本机执行');

  const noReq = runPreflight({ ...ctxOf([local()]), subtasks: [sub('闲聊', req({ categories: [], intents: [], deviceClasses: [] }))] });
  eq(noReq.verdict, 'ok', 'B7 三面全空＝没有能力要求（对话/判不出）⇒ 不判死');

  const record = toPreflightRecord(noNodes);
  eq('notes' in record, false, 'B8 落库记录不带旁注（判定归判定，披露归披露）');
}

// ═══ C｜环依赖：不整批拒绝，按边丢并点名 ═══════════════════════════════════════
const SCHEMA = `
CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
  status TEXT DEFAULT 'active', working_dir TEXT DEFAULT '', context_json TEXT DEFAULT '{}',
  sandbox_mode TEXT DEFAULT 'workspace', autonomous_mode TEXT DEFAULT 'off',
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT, title TEXT NOT NULL, description TEXT DEFAULT '',
  status TEXT DEFAULT 'pending', context_json TEXT DEFAULT '{}', workflow_config TEXT DEFAULT '{}',
  priority INTEGER DEFAULT 0,
  depends_on TEXT DEFAULT '', parent_task_id TEXT DEFAULT '', source TEXT DEFAULT 'user',
  acceptance_criteria TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
  aggregate_version INTEGER DEFAULT 0, quality_score REAL);
CREATE TABLE wa_task_conversations (id TEXT PRIMARY KEY, task_id TEXT, role TEXT NOT NULL,
  content TEXT DEFAULT '', tool_calls TEXT, token_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')));
`;

function freshDb(): DatabaseSync {
  const d = new DatabaseSync(':memory:');
  d.exec(SCHEMA);
  return d;
}
function mkParent(d: DatabaseSync, pid: string, tid: string): void {
  d.prepare('INSERT INTO wa_projects (id, name) VALUES (?, ?)').run(pid, pid);
  d.prepare("INSERT INTO wa_tasks (id, project_id, title, status) VALUES (?, ?, ?, 'pending')").run(tid, pid, tid);
}
const tpl = (title: string, dependsOn?: number[], capabilities?: string[]): DecompositionTemplate => ({
  title, description: 'd', acceptance_criteria: 'a',
  ...(dependsOn ? { dependsOn } : {}),
  ...(capabilities ? { capabilities } : {}),
});
const kidsOf = (d: DatabaseSync, pid: string) =>
  d.prepare('SELECT id, title, depends_on, context_json FROM wa_tasks WHERE parent_task_id = ? ORDER BY priority DESC, rowid').all(pid) as
    Array<{ id: string; title: string; depends_on: string; context_json: string }>;
const taskCount = (d: DatabaseSync) => (d.prepare('SELECT COUNT(*) AS c FROM wa_tasks').get() as { c: number }).c;

function sectionC(): void {
  console.log('\n【C】环依赖不整批拒绝（既有更强行为保持不变）');

  const d = freshDb(); mkParent(d, 'p-cyc', 'CY');
  const r = planSubtasksFromTemplate(d as never, {
    parentTaskId: 'CY', projectId: 'p-cyc', depth: 0, source: 'auto-decompose',
    template: [tpl('甲', [2], ['text']), tpl('乙', [1], ['text'])],
    preflight: ctxOf([local()]),
  });
  eq([r.created, r.droppedDeps, r.preflight?.verdict], [2, 1, 'ok'],
    'C1 ★环依赖：两行照建、恰丢闭环边，预检仍为 ok（不整批拒绝）');
  const rows = kidsOf(d, 'CY');
  ok(rows[0]?.depends_on === rows[1]?.id && rows[1]?.depends_on === '',
    'C2 ★有效 DAG：留下先接纳的边，互锁行不落库',
    rows.map((x) => `${x.title}:${x.depends_on || '(无)'}`).join(' / '));
  ok(droppedDepsNotice(r.droppedDepNotes).includes('「乙」的前置「甲」'),
    'C3 被丢的边被点名（不是只报个数）', droppedDepsNotice(r.droppedDepNotes));

  const d2 = freshDb(); mkParent(d2, 'p-dag', 'DAG');
  const r2 = planSubtasksFromTemplate(d2 as never, {
    parentTaskId: 'DAG', projectId: 'p-dag', depth: 0, source: 'auto-decompose',
    template: [tpl('甲', [2], ['text']), tpl('乙', undefined, ['text'])],
    preflight: ctxOf([local()]),
  });
  eq([r2.created, r2.droppedDeps], [2, 0], 'C4 **反证（先声明后引用、无环）**：一条边不丢');
  eq(droppedDepsNotice(r2.droppedDepNotes), '', 'C5 无丢边 ⇒ 文案为空串');
}

// ═══ D｜预检不过零落行；过了结论随需求落库 ═══════════════════════════════════
function sectionD(): void {
  console.log('\n【D】预检不过 ⇒ 零落行（无半成品）；过了 ⇒ 结论落库');

  const d = freshDb(); mkParent(d, 'p-cap', 'CAP');
  const before = taskCount(d);
  const r = planSubtasksFromTemplate(d as never, {
    parentTaskId: 'CAP', projectId: 'p-cap', depth: 0, source: 'auto-decompose',
    // 第 1 条本可建、第 2 条要求本机没有的媒体能力 —— 若「边建边判」就会留下半成品。
    template: [tpl('甲', undefined, ['text']), tpl('乙', undefined, ['media']), tpl('丙', undefined, ['text'])],
    preflight: ctxOf([local()]),
  });
  eq([r.created, r.preflight?.verdict], [0, 'no-capable-node'], 'D1 ★能力缺口 ⇒ created=0 且结论如实');
  eq(taskCount(d) - before, 0, 'D2 ★★**零落行**：整批在 SAVEPOINT 之前被拒，库里一行未多');
  eq(kidsOf(d, 'CAP').length, 0, 'D3 父任务下无任何子任务（不落半成品）');
  ok((r.refusal ?? '') === (r.preflight?.reason ?? ''), 'D4 拒因与预检结论逐字同源（不另写一句）');

  const d2 = freshDb(); mkParent(d2, 'p-bud', 'BUD');
  const before2 = taskCount(d2);
  const r2 = planSubtasksFromTemplate(d2 as never, {
    parentTaskId: 'BUD', projectId: 'p-bud', depth: 0, source: 'auto-decompose',
    template: [tpl('甲', undefined, ['text'])],
    preflight: ctxOf([local()], true, MIN_SUBTASK_TOKENS - 1),
  });
  eq([r2.created, r2.preflight?.verdict], [0, 'budget-impossible'], 'D5 ★预算不可行 ⇒ created=0');
  eq(taskCount(d2) - before2, 0, 'D6 ★预算拒绝同样零落行');

  const d3 = freshDb(); mkParent(d3, 'p-ok', 'OK');
  const r3 = planSubtasksFromTemplate(d3 as never, {
    parentTaskId: 'OK', projectId: 'p-ok', depth: 0, source: 'auto-decompose',
    template: [tpl('甲', undefined, ['text']), tpl('乙', undefined, ['text'])],
    preflight: ctxOf([local(), node({ nodeId: 'peer-2', online: false })], false, null),
  });
  eq(r3.created, 2, 'D7 预检通过 ⇒ 正常落行');
  const stored = kidsOf(d3, 'OK').map((x) => JSON.parse(x.context_json)[DISPATCH_REQUIREMENTS_KEY]);
  eq(stored.map((s) => s.preflight?.verdict), ['ok', 'ok'], 'D8 ★每个子任务的预检结论随需求落库');
  eq(stored[0]?.preflight?.peersKnown, false, 'D9 落库保留「远端是否核过」这一格（不装已核）');
  eq(stored[0]?.preflight?.nodeCount, 2, 'D10 落库保留判定节点数（可核对凭几台机器判的）');
  eq(stored[0]?.preflight?.reason, undefined, 'D11 ok 不写 reason（不拿空串冒充「有话说」）');

  // 未传预检环境 ⇒ 旧行为（不预检、不落 preflight 键）。
  const d4 = freshDb(); mkParent(d4, 'p-none', 'NONE');
  planSubtasksFromTemplate(d4 as never, {
    parentTaskId: 'NONE', projectId: 'p-none', depth: 0, source: 'auto-decompose',
    template: [tpl('甲', undefined, ['text'])],
  });
  const plain = JSON.parse(kidsOf(d4, 'NONE')[0]!.context_json)[DISPATCH_REQUIREMENTS_KEY];
  eq('preflight' in plain, false, 'D12 不预检的旧路不写 preflight 键（向后兼容，不伪造已预检）');
}

// ═══ E｜洗形不连坐 ═══════════════════════════════════════════════════════════
function sectionE(): void {
  console.log('\n【E】预检是引擎旁注：坏了只丢该字段，不连坐需求');

  const good = { ...req(), preflight: { verdict: 'nodes-offline', reason: '只有离线节点', peersKnown: true, nodeCount: 2 } };
  const kept = sanitizeDispatchRequirements(good);
  eq(kept?.preflight?.verdict, 'nodes-offline', 'E1 合法预检 ⇒ 保留');

  const badVerdict = sanitizeDispatchRequirements({ ...req(), preflight: { verdict: 'not-a-verdict', peersKnown: true, nodeCount: 2 } });
  ok(badVerdict !== null && !('preflight' in badVerdict), 'E2 ★坏结局码 ⇒ 只丢预检字段，需求仍可用（不连坐）');
  eq(badVerdict?.categories, ['text'], 'E3 需求三面原样保留');

  const badCount = sanitizeDispatchRequirements({ ...req(), preflight: { verdict: 'ok', peersKnown: true, nodeCount: -1 } });
  ok(badCount !== null && !('preflight' in badCount), 'E4 坏节点数同样只丢该字段');

  const badWord = sanitizeDispatchRequirements({ ...req({ categories: ['不存在的类目'] }), preflight: good.preflight });
  eq(badWord, null, 'E5 **反证（模型声明的三面坏）**：仍整块作废（两把尺各管各的）');

  const json = JSON.stringify({ [DISPATCH_REQUIREMENTS_KEY]: good });
  const viaTask = requirementsForTask({ title: 'x', contextJson: json });
  eq(viaTask.preflight?.verdict, 'nodes-offline', 'E6 读任务行那一跳也保留预检结论');
}

// ═══ F｜接线与构建钉 ═════════════════════════════════════════════════════════
function sectionF(): void {
  console.log('\n【F】接线与构建钉');

  const dec = stripKeepingLines(fs.readFileSync(path.join(DESKTOP, 'core/task-decompose.ts'), 'utf-8')).join('\n');
  ok(dec.includes('collectPreflightContext(opts.db'), 'F1 引擎路真取预检环境（取不到则不预检）');
  ok(dec.includes('...(preflight ? { preflight } : {})'), 'F2 引擎路把环境传给唯一落行实现');
  ok(dec.includes('if (r.created === 0)') && dec.includes('r.preflight.reason'),
    'F3 引擎路对预检失败**说清原因**（不静默返回 null）');

  const im = stripKeepingLines(fs.readFileSync(path.join(DESKTOP, 'services/im-router.ts'), 'utf-8')).join('\n');
  ok(im.includes('collectPreflightContext(ctx.db'), 'F4 IM 路与引擎路同取数');
  ok(im.includes('if (r.created === 0)') && im.includes('r.preflight?.reason'),
    'F5 IM 路 `created===0` 有分支（堵住「拆分为 0 个」死单）');
  eq((im.match(/decomposeNote\}/g) ?? []).length, 2, 'F6 两条单任务回执都挂上「未能拆分」说明');

  const pre = stripKeepingLines(fs.readFileSync(path.join(DESKTOP, 'core/task-preflight.ts'), 'utf-8')).join('\n');
  eq((pre.match(/export function runPreflight/g) ?? []).length, 1, 'F7 预检判定恰一份实现');
  ok(pre.includes("from './node-match.js'") && pre.includes('capabilityGap('),
    'F8 「具备不具备」复用 node-match 的同一把尺');

  const match = stripKeepingLines(fs.readFileSync(path.join(DESKTOP, 'core/node-match.ts'), 'utf-8')).join('\n');
  ok(match.includes('export function capabilityGap') && match.includes('const gap = capabilityGap(profile, req)'),
    'F9 派发匹配与预检同引 `capabilityGap`（不另写第二把尺）');

  const { tag } = deriveBuildTag(fs.readFileSync(path.join(DESKTOP, 'core/agent-executor.ts'), 'utf-8'));
  ok(buildNotOlderThan(tag, SELF_ROUND), 'F10 build 标识不早于脚本轮次（方向性派生）', `${tag} vs ${SELF_ROUND}`);
  checkBuildPins(ok, { rootDir: ROOT });
}

sectionA();
sectionB();
sectionC();
sectionD();
sectionE();
sectionF();

console.log(`\n[rr_${SELF_ROUND}_preflight] ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
