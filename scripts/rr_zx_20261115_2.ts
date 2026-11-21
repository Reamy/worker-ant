/**
 * zx_20261115_2「收·继·面」——中继任务树有界、约束随树继承、成功收口判据的受控回归。
 *
 * 分组：
 *   S「钉」构建钉与本轮方案在册（checkBuildPins 派生，不写"只为下一轮"的字面量）。
 *   A「树」relay-tree 纯函数：begin/read/refusal（超深/超总数/过期）；无树恒放行（反证）。
 *   B「继」约束继承：buildChildContext / inheritedConstraintContext / retry 携带约束；无键不多键（反证）。
 *   C「拆」真跑 planSubtasksFromTemplate：子任务继承 relay_tree/position_id；超深/超总数/过期拒拆且零残留。
 *   D「停」terminateRelayTree：整树归档、远端叫停、已终态不动；叫停失败如实进 errors。
 *   E「因」新暂停因由的词表/定局谓词/横幅提示。
 *   F「判」E2E 收口判据：只认 completed + verified + 产出清单；failed 不放行（反证）。
 *
 * 纪律：零网络 / 零墙钟依赖；夹具按生产初始化顺序（先建表再插行）；断言文案不含失败字形。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins, deriveBuildTag } from './lib/rr-pins.js';
import {
  RELAY_TREE_KEY,
  RELAY_TREE_MAX_DEPTH,
  RELAY_TREE_MAX_TASKS,
  beginRelayTree,
  readRelayTree,
  relayTreeRefusal,
  relayTreeTaskCount,
  type RelayTreeBudget,
} from '../apps/worker-ant-desktop/src/main/core/relay-tree.js';
import { terminateRelayTree } from '../apps/worker-ant-desktop/src/main/core/relay-tree-terminate.js';
import {
  buildChildContext,
  carryRetryContext,
  inheritedConstraintContext,
  INHERITED_CONSTRAINT_KEYS,
} from '../apps/worker-ant-desktop/src/main/core/task-accounting.js';
import { planSubtasksFromTemplate as planSubtasksFromTemplateReal } from '../apps/worker-ant-desktop/src/main/core/task-decompose.js';
// zx_20261120_3 M1：子任务继承岗位改为“父岗位有效才继承”——夹具需按生产建岗位表并绑定（不再盲继承裸 id）。
import { POSITIONS_DDL } from '../apps/worker-ant-desktop/src/main/core/positions.js';
import {
  PAUSE_REASON_RELAY_TREE_EXPIRED,
  pauseReasonLabel,
  pauseSettlesParent,
} from '../apps/worker-ant-desktop/src/main/core/pause-reason.js';
import { pausedBannerHint } from '../apps/worker-ant-desktop/renderer/src/lib/pause-banner.js';
import { judgeRelayE2E } from './lib/e2e-judge.js';

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  PASS ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}
function eq(actual: unknown, expect: unknown, label: string): void {
  ok(JSON.stringify(actual) === JSON.stringify(expect), label, `${JSON.stringify(actual)} vs ${JSON.stringify(expect)}`);
}

const root = path.join(__dirname, '..');
const A = 'apps/worker-ant-desktop';
const selfRound = path.basename(__filename, '.ts').replace(/^rr_/, '');
const readSrc = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf-8');

/* ── 夹具：生产同形 DDL（含 position_id）──────────────────────────────────── */

const SCHEMA = `
CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_projects (id TEXT PRIMARY KEY, name TEXT DEFAULT '', status TEXT DEFAULT 'active',
  context_json TEXT DEFAULT '{}', created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT, parent_task_id TEXT DEFAULT '', title TEXT NOT NULL DEFAULT '',
  description TEXT DEFAULT '', status TEXT DEFAULT 'pending', priority INTEGER DEFAULT 0, acceptance_criteria TEXT DEFAULT '',
  depends_on TEXT DEFAULT '', context_json TEXT DEFAULT '{}', position_id TEXT DEFAULT '', source TEXT DEFAULT 'user',
  quality_score REAL, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_task_conversations (id TEXT PRIMARY KEY, task_id TEXT, role TEXT NOT NULL DEFAULT 'user', content TEXT DEFAULT '',
  token_count INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_event_log (id INTEGER PRIMARY KEY AUTOINCREMENT, aggregate_type TEXT, aggregate_id TEXT, event_type TEXT, payload TEXT, occurred_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_deliverables (id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, file_path TEXT, created_at TEXT DEFAULT (datetime('now')));
`;

type AnyDb = import('better-sqlite3').Database;

function fixture(): AnyDb {
  const d = new DatabaseSync(':memory:') as unknown as AnyDb;
  d.exec(SCHEMA);
  d.exec(POSITIONS_DDL);
  d.prepare("INSERT INTO wa_projects (id, name) VALUES ('P-1', '测试项目')").run();
  return d;
}

function insertTask(db: AnyDb, id: string, opts: {
  status?: string; parent?: string; context?: Record<string, unknown>; positionId?: string;
} = {}): void {
  db.prepare('INSERT INTO wa_tasks (id, project_id, parent_task_id, title, status, context_json, position_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, 'P-1', opts.parent ?? '', id, opts.status ?? 'pending', JSON.stringify(opts.context ?? {}), opts.positionId ?? '');
}

const TREE: RelayTreeBudget = beginRelayTree(1_000_000, 600_000, 'T-root');
/** C 组用**真实时钟**起树（`planSubtasksFromTemplate` 内没有 now 注入）——否则一建就过期。 */
const LIVE_TREE: RelayTreeBudget = beginRelayTree(Date.now(), 600_000, 'T-root');

/* ── S：构建钉与方案在册 ─────────────────────────────────────────────────── */

function sectionS(): void {
  console.log('\n【S】构建钉与本轮方案');
  checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });
  const plan = readSrc(`plans/improve/${selfRound}.md`);
  ok(plan.includes(selfRound), 'S1 本轮方案在册且带轮次名');
  ok(plan.includes('relay_tree') && plan.includes('terminateRelayTree'), 'S2 方案记下树预算与真停两个承重件');
  ok(plan.includes('no_interaction') && plan.includes('position_id'), 'S3 方案记下约束继承的两个关键键');
  const { tag } = deriveBuildTag(readSrc(`${A}/src/main/core/agent-executor.ts`));
  ok(tag >= selfRound, 'S4 构建钉不早于本脚本轮次', `${tag} >= ${selfRound}`);
  // 正直面断言：方案**确有**"两物理机未验/不宣称"这句诚实边界；不玩"复述即反例"的字面陷阱。
  ok(plan.includes('两物理机') && (plan.includes('不宣称') || plan.includes('未验')),
    'S5 诚实边界：方案如实记两物理机未验（不宣称已验证）');
}

/* ── A：relay-tree 纯函数 ────────────────────────────────────────────────── */

function sectionA(): void {
  console.log('\n【A】树预算：begin / read / refusal');
  const t = beginRelayTree(5_000, 600_000, 'root-1');
  eq(t.root_id, 'root-1', 'A1 根 id 原样落盘');
  eq(t.base_depth, 0, 'A2 顶层根 base_depth=0');
  eq(t.max_depth, RELAY_TREE_MAX_DEPTH, 'A3 相对深度上限取常量');
  eq(t.max_tasks, RELAY_TREE_MAX_TASKS, 'A4 总任务数上限取常量');
  eq(t.deadline_at, 5_000 + 600_000 - 60_000, 'A5 时窗 = timeout - 余量');
  const tiny = beginRelayTree(1_000, 10, 'root-2');
  ok(tiny.deadline_at >= 2_000, 'A6 极小 timeout 也至少留 1 秒（不造"建单即过期"）', String(tiny.deadline_at));

  eq(readRelayTree({ [RELAY_TREE_KEY]: t })?.root_id, 'root-1', 'A7 对象上下文可读');
  eq(readRelayTree(JSON.stringify({ [RELAY_TREE_KEY]: t }))?.deadline_at, t.deadline_at, 'A8 JSON 串上下文可读');
  eq(readRelayTree('{}'), null, 'A9 无键 ⇒ null（旧任务不变）');
  eq(readRelayTree('{bad'), null, 'A10 坏 JSON ⇒ null（不抛）');
  eq(readRelayTree({ [RELAY_TREE_KEY]: { root_id: '', max_depth: 1 } }), null, 'A11 坏形状 ⇒ null（不编默认树）');

  const db = fixture();
  insertTask(db, 'T-root', { context: { [RELAY_TREE_KEY]: t } });
  eq(relayTreeTaskCount(db, t), 1, 'A12 树任务数含根（1）');
  eq(relayTreeRefusal(db, { [RELAY_TREE_KEY]: t }, 1, 5_000), null, 'A13 第 1 层允许');
  ok(String(relayTreeRefusal(db, { [RELAY_TREE_KEY]: t }, 2, 5_000)).includes('只允许拆解'), 'A14 第 2 层拒拆且理由点名深度');
  ok(String(relayTreeRefusal(db, { [RELAY_TREE_KEY]: { ...t, deadline_at: 4_000 } }, 1, 5_000)).includes('总时窗已用尽'), 'A15 过期拒拆且理由点名时窗');
  ok(String(relayTreeRefusal(db, { [RELAY_TREE_KEY]: { ...t, max_tasks: 1 } }, 1, 5_000)).includes('任务上限'), 'A16 总数到顶拒拆');
  eq(relayTreeRefusal(db, {}, 99, 9_999_999), null, 'A17 无 relay_tree 恒放行（本地任务零变化）');
  // 坏 DB（无 wa_tasks）⇒ 计数读不到，但不因"读不到"误拦
  const bad = new DatabaseSync(':memory:') as unknown as AnyDb;
  eq(relayTreeRefusal(bad, { [RELAY_TREE_KEY]: t }, 1, 5_000), null, 'A18 计数读不到 ⇒ 不误拦（深度仍可判）');
  bad.close();
  db.close();
}

/* ── B：约束随树继承 ─────────────────────────────────────────────────────── */

function sectionB(): void {
  console.log('\n【B】约束继承：四键 + position_id 的同源白名单');
  const tree = { root_id: 'r', base_depth: 0, max_depth: 1, max_tasks: 8, deadline_at: 9_999_999 };
  const parent = {
    no_interaction: true,
    node_archetype: 'research',
    dispatch_position: { id: 'pos-remote', name: '调研岗', tools: ['read_file'] },
    [RELAY_TREE_KEY]: tree,
  };
  const child = buildChildContext(parent, 1);
  eq(child.depth, 1, 'B1 depth 仍按子层递增');
  eq(child.no_interaction, true, 'B2 no_interaction 随树');
  eq(child.node_archetype, 'research', 'B3 类目原型随树');
  eq(child.dispatch_position, parent.dispatch_position, 'B4 跨机岗位白名单随树');
  eq(child[RELAY_TREE_KEY], tree, 'B5 树预算随树');

  const plain = buildChildContext({}, 1);
  eq(plain, { depth: 1 }, 'B6 父无这些键 ⇒ 子不多添键（反证）');
  const falseNi = buildChildContext({ no_interaction: false }, 1);
  ok(!('no_interaction' in falseNi), 'B7 只认显式 true（false 不继承）');

  eq(inheritedConstraintContext(null), {}, 'B8 空父上下文 ⇒ 空对象');
  eq(INHERITED_CONSTRAINT_KEYS.includes('relay_tree' as never), true, 'B9 白名单含树预算（一处真源）');

  const retry = carryRetryContext(parent);
  eq(retry.no_interaction, true, 'B10 retry 携带 no_interaction（重跑不放宽约束）');
  eq(retry.node_archetype, 'research', 'B11 retry 携带类目原型');
  ok('dispatch_position' in retry && RELAY_TREE_KEY in retry, 'B12 retry 携带跨机岗位与树预算');
  eq(carryRetryContext({}), {}, 'B13 无这些键 ⇒ 不多添（反证）');
}

/* ── C：真跑拆解落行 ─────────────────────────────────────────────────────── */

const TEMPLATE = [
  { title: '第一步', description: '做第一步', acceptance_criteria: '完成', purpose: '推进' },
  { title: '第二步', description: '做第二步', acceptance_criteria: '完成', purpose: '推进' },
  { title: '第三步', description: '做第三步', acceptance_criteria: '完成', purpose: '推进' },
];

function childrenOf(db: AnyDb, parent: string): Array<{ id: string; position_id: string; context_json: string }> {
  return db.prepare('SELECT id, position_id, context_json FROM wa_tasks WHERE parent_task_id = ?').all(parent) as never;
}

function sectionC(): void {
  console.log('\n【C】真跑 planSubtasksFromTemplate：继承与三道界');
  {
    const db = fixture();
    // 生产同形：岗位存在且在本项目启用，父任务才可能带岗位（否则派生判“失效不继承”）。
    db.prepare(
      `INSERT INTO wa_positions (id, name, category, description, skills_json, rules_json, knowledge_json, enabled, builtin, version)
       VALUES ('pos-1', '测试岗', 'tech', '', '[]', '[]', '[]', 1, 0, 1)`,
    ).run();
    db.prepare("INSERT INTO wa_project_positions (project_id, position_id, enabled) VALUES ('P-1', 'pos-1', 1)").run();
    insertTask(db, 'T-root', { context: { [RELAY_TREE_KEY]: LIVE_TREE }, positionId: 'pos-1' });
    const r = planSubtasksFromTemplateReal(db, { parentTaskId: 'T-root', projectId: 'P-1', template: TEMPLATE, depth: 0, source: 'auto-decompose' });
    eq(r.created, 3, 'C1 未超限 ⇒ 三条全建');
    const kids = childrenOf(db, 'T-root');
    ok(kids.every((k) => k.position_id === 'pos-1'), 'C2 子任务继承父 position_id（正面断言）');
    ok(kids.every((k) => (JSON.parse(k.context_json) as Record<string, unknown>)[RELAY_TREE_KEY] != null),
      'C3 子任务继承 relay_tree（树身份不断）');
    db.close();
  }
  {
    const db = fixture();
    insertTask(db, 'T-root', { context: { [RELAY_TREE_KEY]: LIVE_TREE } });
    insertTask(db, 'T-child', { parent: 'T-root', context: { depth: 1, [RELAY_TREE_KEY]: LIVE_TREE } });
    const r = planSubtasksFromTemplateReal(db, { parentTaskId: 'T-child', projectId: 'P-1', template: TEMPLATE, depth: 1, source: 'auto-decompose' });
    eq(r.created, 0, 'C4 第 2 层 ⇒ 零建（正面断言）');
    ok(String(r.refusal).includes('只允许拆解'), 'C5 拒因点名深度');
    eq(childrenOf(db, 'T-child').length, 0, 'C6 零残留');
    db.close();
  }
  {
    const db = fixture();
    insertTask(db, 'T-root', { context: { [RELAY_TREE_KEY]: { ...LIVE_TREE, max_tasks: 1 } } });
    const r = planSubtasksFromTemplateReal(db, { parentTaskId: 'T-root', projectId: 'P-1', template: TEMPLATE, depth: 0, source: 'auto-decompose' });
    eq(r.created, 0, 'C7 总数到顶 ⇒ 零建');
    ok(String(r.refusal).includes('任务上限'), 'C8 拒因点名总数');
    db.close();
  }
  {
    const db = fixture();
    insertTask(db, 'T-root', { context: { [RELAY_TREE_KEY]: { ...LIVE_TREE, deadline_at: 1 } } });
    const r = planSubtasksFromTemplateReal(db, { parentTaskId: 'T-root', projectId: 'P-1', template: TEMPLATE, depth: 0, source: 'auto-decompose' });
    eq(r.created, 0, 'C9 过期 ⇒ 零建');
    ok(String(r.refusal).includes('总时窗'), 'C10 拒因点名时窗');
    db.close();
  }
  {
    const db = fixture();
    insertTask(db, 'T-root', { context: {} });
    const r = planSubtasksFromTemplateReal(db, { parentTaskId: 'T-root', projectId: 'P-1', template: TEMPLATE, depth: 0, source: 'auto-decompose' });
    eq(r.created, 3, 'C11 无 relay_tree 的旧任务照常拆（反证）');
    const kids = childrenOf(db, 'T-root');
    ok(kids.every((k) => !(RELAY_TREE_KEY in (JSON.parse(k.context_json) as Record<string, unknown>))), 'C12 旧任务子上下文不凭空多树键（反证）');
    ok(kids.every((k) => k.position_id === ''), 'C13 父无岗位 ⇒ 子为空（反证）');
    db.close();
  }
  // 静态接线：create_task / spawn_subagent 的 INSERT 也写 position_id，并调同一判据
  const control = readSrc(`${A}/src/main/core/tools/control.ts`);
  const resource = readSrc(`${A}/src/main/core/tools/resource.ts`);
  ok(/relayTreeRefusal/.test(control) && /position_id/.test(control), 'C14 create_task 接线树判据与 position_id');
  ok(/relayTreeRefusal/.test(resource) && /position_id/.test(resource), 'C15 spawn_subagent 接线树判据与 position_id');
}

/* ── D：整树真停 ─────────────────────────────────────────────────────────── */

async function sectionD(): Promise<void> {
  console.log('\n【D】terminateRelayTree：整树归档 + 远端叫停');
  const db = fixture();
  insertTask(db, 'T-root', { context: {} });
  insertTask(db, 'T-kid1', { parent: 'T-root', context: { assigned_node_id: 'node-x', assigned_request_id: 'req-x' } });
  insertTask(db, 'T-kid2', { parent: 'T-root', status: 'completed', context: {} });
  insertTask(db, 'T-kid3', { parent: 'T-root', status: 'paused', context: {} });
  const calls: string[] = [];
  const res = await terminateRelayTree(db, 'T-root', 'node_request_timeout', {
    cancel: async (id) => { calls.push(id); return { ok: true }; },
  });
  eq(res.treeSize, 4, 'D1 整树成员数含根（4）');
  eq(res.archived, 3, 'D2 非终态三行归档、completed 不动');
  eq(calls, ['req-x'], 'D3 远端 assigned 行真发叫停（恰一次）');
  eq(res.cancelledRemote, 1, 'D4 叫停计数如实');
  const rows = db.prepare("SELECT id, status FROM wa_tasks WHERE id IN ('T-root','T-kid1','T-kid2','T-kid3') ORDER BY id").all() as Array<{ id: string; status: string }>;
  eq(rows.map((r) => r.status), ['archived', 'completed', 'archived', 'archived'], 'D5 归档结果逐行核对（已终态不改写）');

  // 叫停失败：如实进 errors，不谎称已停
  const db2 = fixture();
  insertTask(db2, 'T-root', { context: {} });
  insertTask(db2, 'T-kid', { parent: 'T-root', context: { assigned_node_id: 'node-y', assigned_request_id: 'req-y' } });
  const res2 = await terminateRelayTree(db2, 'T-root', 'node_request_timeout', { cancel: async () => ({ ok: false, note: 'denied' }) });
  ok(res2.errors.some((e) => e.includes('denied')), 'D6 叫停失败如实进 errors（不冒充已停）');
  eq(res2.archived, 2, 'D7 本机归档仍成立');
  db.close(); db2.close();
}

/* ── E：新暂停因由 ───────────────────────────────────────────────────────── */

function sectionE(): void {
  console.log('\n【E】relay_tree_expired：词表 / 定局 / 横幅');
  eq(PAUSE_REASON_RELAY_TREE_EXPIRED, 'relay_tree_expired', 'E1 因由码与方案一致');
  eq(pauseReasonLabel(PAUSE_REASON_RELAY_TREE_EXPIRED), '本次派单的任务树总时窗已用尽', 'E2 中文词表在册');
  eq(pauseSettlesParent(PAUSE_REASON_RELAY_TREE_EXPIRED), true, 'E3 视为定局（父任务可被放行）');
  ok(pausedBannerHint(PAUSE_REASON_RELAY_TREE_EXPIRED).includes('任务树'), 'E4 横幅提示点名任务树');
  const reasonSrc = readSrc(`${A}/src/main/core/pause-reason.ts`);
  ok(reasonSrc.includes(PAUSE_REASON_RELAY_TREE_EXPIRED), 'E5 常量在 pause-reason 一处真源');
}

/* ── F：E2E 收口判据 ─────────────────────────────────────────────────────── */

function sectionF(): void {
  console.log('\n【F】judgeRelayE2E：只认真的完成');
  eq(judgeRelayE2E({ remoteSeen: true, localStatus: 'completed', receiptVerdict: 'verified', outputs: [{}] }).ok, true, 'F1 四件事齐 ⇒ 通过');
  eq(judgeRelayE2E({ remoteSeen: true, localStatus: 'failed', receiptVerdict: 'verified', outputs: [{}] }).ok, false, 'F2 failed 不放行（反证）');
  eq(judgeRelayE2E({ remoteSeen: true, localStatus: 'paused', receiptVerdict: 'verified', outputs: [{}] }).ok, false, 'F3 paused 不放行');
  eq(judgeRelayE2E({ remoteSeen: true, localStatus: 'completed', receiptVerdict: 'self-reported', outputs: [{}] }).ok, false, 'F4 自报完成不放行');
  eq(judgeRelayE2E({ remoteSeen: true, localStatus: 'completed', receiptVerdict: 'verified', outputs: [] }).ok, false, 'F5 无产出不放行');
  eq(judgeRelayE2E({ remoteSeen: false, localStatus: 'completed', receiptVerdict: 'verified', outputs: [{}] }).ok, false, 'F6 对端没建任务不放行');
  const e2e = readSrc('scripts/e2e_zx_20261112_2.ts');
  ok(e2e.includes('judgeRelayE2E'), 'F7 E2E 脚本走同一判据（不手抄第二份）');
  // 旧**成功判据**是 `remoteSeen && (completed || failed)`；轮询循环里 `failed` 作为终态提前跳出是另一件事。
  ok(!/remoteSeen && \(localStatus === 'completed' \|\| localStatus === 'failed'\)/.test(e2e),
    'F8 旧"failed 也算收口"成功判据已不存在（反证）');
}

/* ── G：三页第一眼与失败态（静态接线钉）──────────────────────────────────── */

function sectionG(): void {
  console.log('\n【G】项目详情 / 协同面板 / 设备管理：首屏与失败态');
  const pd = readSrc(`${A}/renderer/src/pages/ProjectDetailPage.tsx`);
  ok(/void loadMilestones\(\)/.test(pd), 'G1 项目详情首屏即读里程碑/阻塞（不再等用户点页签）');
  ok(/milestoneLoaded/.test(pd) && /阻塞 读取中/.test(pd), 'G2 未读到阻塞项时显示「读取中」而非 0');
  ok(/tabErrors/.test(pd) && /LoadFailure/.test(pd), 'G3 四页签读失败接错误块（不再伪装「暂无」）');
  ok(/pjDelivRetired/.test(pd) && /含已退休/.test(pd), 'G4 产出物两处口径可解释（含已退休 R 条）');
  ok(/lastActive/.test(pd) && /最近活动于/.test(pd), 'G5 首屏补最近活动时刻');
  ok(!/activeHourStart \|\| 9/.test(pd) && /activeHourStart == null/.test(pd), 'G6 0 是合法值（不再用 || 顶成 9/2）');

  const peers = readSrc(`${A}/renderer/src/pages/PeersPage.tsx`);
  ok(/canDispatchNow/.test(peers) && /canDispatchNow\(node, nowMs\)/.test(peers), 'G7 可派单徽标与下拉同一判据');
  ok(/participateOutKnown/.test(peers) && /readParticipateOut/.test(peers), 'G8 派活开关读失败不按「允许」写回');
  ok(/LoadFailure/.test(peers) && /「ANS 节点台账」/.test(peers), 'G9 节点台账读失败可见可重试');
  ok(peers.indexOf('<DoorCard />') > peers.indexOf('自知者明 · 本机'), 'G10 节点区在门卡之前（首屏先看到工蚁节点）');
  ok(/最近 \$\{records.length\} 条，上限 50/.test(peers), 'G11 台账条数写明窗口（不把 limit 说成全部）');

  const dev = readSrc(`${A}/renderer/src/pages/DevicesPage.tsx`);
  ok(/设备台账没读到/.test(dev) && /这不是「一台设备都没有」/.test(dev), 'G12 设备台账首读失败不冒充空台账');
  ok(/refreshStatesNow/.test(dev) && /逐台明细/.test(dev), 'G13 发现/直查失败上屏且可展开');
  ok(/设备台账<\/span>/.test(dev) && dev.indexOf('设备台账</span>') < dev.indexOf('<MqttConfigBlock'), 'G14 台账在配置块之前');
  ok(/在线 \{onlineDevices.length\}/.test(dev) && /已授权 \{authorizedDevices.length\}/.test(dev), 'G15 标题行四个真数');
  ok(!/formatDbTime\([^)]*\)\} UTC/.test(dev), 'G16 去掉「本地时间 + UTC」混标');
  ok(/statusView/.test(dev) && /搜索名称/.test(dev), 'G17 列表补搜索与状态筛选');

  const pill = readSrc(`${A}/renderer/src/components/FreshnessPill.tsx`);
  ok(/q\.error/.test(pill) && /未读到 · 重试/.test(pill), 'G18 从未成功加载时不再显示绿色「实时」');
}

function main(): void {
  sectionS();
  sectionA();
  sectionB();
  sectionC();
  sectionG();
  void sectionD().then(() => {
    sectionE();
    sectionF();
    console.log(`\n[rr_zx_20261115_2] ${pass} passed, ${fail} failed`);
    process.exit(fail > 0 ? 1 : 0);
  });
}

main();
