/**
 * zx_20261104_3「联」受控回归 —— 派得出去，也收得回来。
 *
 * A 子任务父状态：暂停/进行中可派，failed/archived/completed/缺失才拒；编排侧同一判据；旧理由清零。
 * B selection：事件 / 台账 / context / 详情四处同值；未提供即 null（不编造）。
 * C 未认领回收：pending + 超时 + 台账确认离线才收；assigned / 读不到台账 / 取消失败一律不动。
 * D 授权台：三类聚合与计数、IM 文案、授予闸有闸、收窄动作无闸。
 * E 离家场景：全屋/单房间、K-6 跳过、高危与开关不入、离家绝不调模型、协议两条。
 * F 渠道配置闸：非空拒 / 空放 / Pro 放 / 非设备键不受影响。
 * G 档位：卖点与闸一一对应、价目表与文档同句。
 * H 静态钉：IPC 名、renderer 调用、/inbox 路由与导航、build pin；另跑哑雷自检。
 *
 * 纪律：零网络 / 零 electron；夹具按生产列形自建 DDL；计数器带 0→1 正面断言；不以真实墙钟为判据。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { AnsDevice } from '../apps/worker-ant-desktop/src/main/core/device-registry.js';
import {
  decideCreateDispatch,
  parentDispatchBlock,
  taskParentDispatchBlock,
  CREATE_DISPATCH_REASON_LABEL,
} from '../apps/worker-ant-desktop/src/main/core/collab-dispatch.js';
import { dispatchNodeRequest, selectionReasonText, type DispatchIo } from '../apps/worker-ant-desktop/src/main/core/node-dispatcher.js';
import { driveRemoteSubtasks, REMOTE_UNCLAIMED_RECLAIM_MS } from '../apps/worker-ant-desktop/src/main/core/node-remote-driver.js';
import {
  markRemoteAssigned,
  remoteSelectionOf,
  remoteTaskView,
  remoteAttemptsOf,
} from '../apps/worker-ant-desktop/src/main/core/node-orchestrate.js';
import { listNodeDispatchRecords } from '../apps/worker-ant-desktop/src/main/core/node-dispatch-log.js';
import {
  buildApprovalInbox,
  formatApprovalInbox,
  formatTerminalList,
  formatDeviceList,
  formatQuestionList,
  formatTerminalCandidate,
  formatRemoteResultNotice,
  deviceActionRefusal,
} from '../apps/worker-ant-desktop/src/main/core/im/approval-inbox.js';
import { planHomeAway, resolveHomeIntent } from '../apps/worker-ant-desktop/src/main/core/home-intent.js';
import { publicIntents, validateIntent, HOME_AWAY_INTENT } from '../apps/worker-ant-desktop/src/main/core/intent-protocol.js';
import { channelSettingRefusal, channelSettingTier, channelSettingOwner } from '../apps/worker-ant-desktop/src/main/core/device-channel.js';
import { benefitCoverageProblems, BENEFIT_COVERAGE } from '../apps/worker-ant-desktop/src/main/core/tier-catalog.js';
import { PRICING } from '../apps/worker-ant-desktop/src/main/core/pricing.js';
import { TEAM_FEATURE_LABEL } from '../apps/worker-ant-desktop/src/main/core/team-gate.js';
import type { AnsNode, AnsNodeRequest } from '@worker-ant/shared-types';
import { ROUND_RE, checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';

const ROOT = path.join(__dirname, '..');
const A = 'apps/worker-ant-desktop';
const SELF_ROUND = path.basename(__filename, '.ts').replace(/^rr_/, '');

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  PASS ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}
function eq(actual: unknown, expect: unknown, label: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expect);
  ok(a === e, label, `${a} vs ${e}`);
}
function readText(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}
function readCode(rel: string): string {
  return stripKeepingLines(readText(rel)).join('\n');
}

/* ── 夹具：按生产列形只建本套件读到的表 ─────────────────────────────────── */
const SCHEMA = `
CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '', updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_tasks (
  id TEXT PRIMARY KEY, project_id TEXT, title TEXT NOT NULL DEFAULT '', description TEXT DEFAULT '',
  status TEXT DEFAULT 'pending', context_json TEXT DEFAULT '{}', depends_on TEXT DEFAULT '',
  parent_task_id TEXT DEFAULT '', acceptance_criteria TEXT DEFAULT '', updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE wa_task_conversations (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL,
  token_count INTEGER NOT NULL DEFAULT 0, created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE wa_event_log (
  id TEXT PRIMARY KEY, aggregate_type TEXT, aggregate_id TEXT, event_type TEXT,
  payload TEXT NOT NULL DEFAULT '{}', occurred_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE wa_audit_events (
  id TEXT PRIMARY KEY, actor_kind TEXT NOT NULL DEFAULT '', actor_ref TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL, target_type TEXT NOT NULL DEFAULT '', target_id TEXT NOT NULL DEFAULT '',
  detail_json TEXT NOT NULL DEFAULT '{}', created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE wa_devices (
  id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', alias TEXT NOT NULL DEFAULT '', room TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'unknown', kind_class TEXT NOT NULL DEFAULT '', protocol TEXT NOT NULL DEFAULT 'mdns',
  address TEXT NOT NULL DEFAULT '', port INTEGER, capabilities_json TEXT NOT NULL DEFAULT '[]',
  controllable INTEGER NOT NULL DEFAULT 0, authorized INTEGER NOT NULL DEFAULT 0, status_json TEXT,
  desired_json TEXT, online INTEGER, first_seen TEXT NOT NULL DEFAULT '', last_seen TEXT NOT NULL DEFAULT ''
);
CREATE TABLE wa_external_terminals (
  id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending',
  pair_code TEXT NOT NULL DEFAULT '', key_prefix TEXT NOT NULL DEFAULT '', secret_hash TEXT NOT NULL DEFAULT '',
  capabilities_json TEXT NOT NULL DEFAULT '[]', grant_expires_at TEXT, last_remote_addr TEXT NOT NULL DEFAULT '',
  last_seen_at TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT 'remote',
  created_at TEXT NOT NULL DEFAULT (datetime('now')), approved_at TEXT, revoked_at TEXT, delivered_at TEXT
);
`;

function makeDb(): DatabaseSync {
  const d = new DatabaseSync(':memory:');
  d.exec(SCHEMA);
  return d;
}
const asBetter = (d: DatabaseSync) => d as unknown as import('better-sqlite3').Database;

/** 已入网本机：身份 + 资源组 + 非占位凭据（`isNodeEnrolled` 的三条件），角色可派。 */
function enrolledDb(): DatabaseSync {
  const d = makeDb();
  const ins = d.prepare('INSERT INTO wa_settings (key, value) VALUES (?, ?)');
  ins.run('node.id', 'n-self');
  ins.run('node.resource_group', 'node:n-self');
  ins.run('node.role', 'primary');
  ins.run('ans_api_key', 'wa_rr_enrolled_key');
  return d;
}

function insertTask(d: DatabaseSync, id: string, parentId = '', status = 'pending', ctx: Record<string, unknown> = {}): void {
  d.prepare(`INSERT INTO wa_tasks (id, project_id, parent_task_id, status, context_json)
    VALUES (?, 'p1', ?, ?, ?)`).run(id, parentId, status, JSON.stringify(ctx));
}
function ctxOf(d: DatabaseSync, id: string): string {
  return String((d.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(id) as { context_json: string }).context_json);
}
function statusOf(d: DatabaseSync, id: string): string {
  return String((d.prepare('SELECT status FROM wa_tasks WHERE id = ?').get(id) as { status: string }).status);
}
function noteOf(d: DatabaseSync, id: string): string {
  const rows = d.prepare('SELECT content FROM wa_task_conversations WHERE task_id = ? ORDER BY created_at ASC').all(id) as Array<{ content: string }>;
  return rows.map((r) => r.content).join('\n');
}
const utcSec = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

function ansNode(nodeId: string, over: Partial<AnsNode> = {}): AnsNode {
  return {
    node_id: nodeId,
    name: nodeId,
    api_key_prefix: '',
    resource_group: `node:${nodeId}`,
    platform: 'darwin/arm64',
    role: 'worker',
    weight: 1,
    participate: true,
    capabilities: [],
    card: null,
    status: null,
    enrolled_at: '2026-11-01 00:00:00',
    last_seen_at: null,
    ...over,
  };
}
function ansRequest(over: Partial<AnsNodeRequest> = {}): AnsNodeRequest {
  return {
    id: 'rq-1', category: 'project_task', payload: {}, requester_key_prefix: 'rr00',
    requester_node_id: 'n-self', target_node_id: 'n-a', status: 'assigned', result: null,
    question: null, answer: null, question_status: null, selection: null, progress: null,
    cancel_requested: false, created_at: '2026-11-01 00:00:00', claimed_at: null, done_at: null,
    ...over,
  };
}
/** 最小可用 IO：每个用例只填它关心的一跳，其余显式抛出（防止"悄悄走了别的路"仍全绿）。 */
function ioOf(o: Partial<DispatchIo>): DispatchIo {
  return {
    async submit() { throw new Error('submit-unused'); },
    async get() { throw new Error('get-unused'); },
    async answer() { throw new Error('answer-unused'); },
    async cancel() { throw new Error('cancel-unused'); },
    ...o,
  };
}

/** 事件真落 `wa_event_log`（`listNodeDispatchRecords` 只读库，不读内存）。 */
function recordingEmit(d: DatabaseSync, captured: Array<{ type: string; data: Record<string, unknown> }>) {
  let n = 0;
  return (type: string, data: Record<string, unknown>) => {
    captured.push({ type, data });
    if (type.startsWith('node.request_')) {
      d.prepare(`INSERT INTO wa_event_log (id, aggregate_type, aggregate_id, event_type, payload, occurred_at)
        VALUES (?, 'node_dispatch', ?, ?, ?, datetime('now'))`)
        .run(`ev-${++n}`, String(data.requestId ?? ''), type, JSON.stringify(data));
    }
    return true;
  };
}

function dev(o: Partial<AnsDevice> & { id: string }): AnsDevice {
  return {
    id: o.id,
    name: o.id,
    alias: '',
    room: '',
    kind: 'unknown',
    kind_class: 'unknown',
    protocol: 'mdns',
    address: '',
    port: null,
    capabilities: [],
    controllable: false,
    authorized: false,
    status: null,
    desired: null,
    online: null,
    first_seen: '',
    last_seen: '',
    ...o,
  };
}

function insertDevice(d: DatabaseSync, x: AnsDevice): void {
  d.prepare(`INSERT INTO wa_devices
    (id, name, alias, room, kind, kind_class, protocol, address, port, capabilities_json,
     controllable, authorized, status_json, desired_json, online, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    x.id, x.name, x.alias, x.room, x.kind, x.kind_class, x.protocol, x.address, x.port,
    JSON.stringify(x.capabilities), x.controllable ? 1 : 0, x.authorized ? 1 : 0,
    x.status === null ? null : JSON.stringify(x.status),
    x.desired === null ? null : JSON.stringify(x.desired),
    x.online === null ? null : (x.online ? 1 : 0),
    x.first_seen, x.last_seen,
  );
}

/** 取一个 IPC handler 的源码体（到下一个 `ipcMain.handle(` 为止）。 */
function handlerBody(code: string, channel: string): string {
  const marker = `'${channel}'`;
  const start = code.indexOf(marker);
  if (start < 0) return '';
  const next = code.indexOf('ipcMain.handle(', start + marker.length);
  return code.slice(start, next < 0 ? code.length : next);
}

/* ═══ A 子任务父状态 ═══════════════════════════════════════════════════════ */
function sectionA(): void {
  console.log('\n【A】子任务父状态：接得住结果的父才拦得住，接不住才拒');
  {
    eq(parentDispatchBlock({}), null, 'A1 无父任务事实 ⇒ 放行');
    eq(parentDispatchBlock({ parentStatus: 'paused' }), null, 'A2 父任务暂停（等子任务的正常态）⇒ 放行（旧行为反过来）');
    eq(parentDispatchBlock({ parentStatus: ' in_progress ' }), null, 'A3 父任务进行中（含首尾空白）⇒ 放行');
    eq(parentDispatchBlock({ parentStatus: 'pending' }), null, 'A4 父任务 pending ⇒ 放行');
    eq(parentDispatchBlock({ parentStatus: 'failed' }), 'parent-failed', 'A5 父任务失败 ⇒ 拒（结果无处可回）');
    eq(parentDispatchBlock({ parentStatus: 'archived' }), 'parent-archived', 'A6 父任务归档 ⇒ 拒');
    eq(parentDispatchBlock({ parentStatus: 'completed' }), 'parent-completed', 'A7 父任务已完成 ⇒ 拒');
    eq(parentDispatchBlock({ parentExists: false, parentStatus: 'paused' }), 'parent-missing', 'A8 父任务行已不存在 ⇒ 拒');

    const base = {
      settingOn: true, teamUnlocked: true, enrolled: true,
      hasDependencies: false, hasAttachments: false, hasWorkingDir: false, decomposed: false,
      category: 'project_task' as const, autoDispatchSource: 'explicit' as const,
    };
    const paused = decideCreateDispatch({ ...base, parentStatus: 'paused' });
    eq([paused.eligible, paused.reason], [true, 'eligible'], 'A9 两只标本之一：父任务暂停仍可派');
    const failed = decideCreateDispatch({ ...base, parentStatus: 'failed' });
    eq([failed.eligible, failed.reason], [false, 'parent-failed'], 'A10 两只标本之二：父任务失败即拒');
    eq(decideCreateDispatch({ ...base, settingOn: false, parentStatus: 'failed' }).reason, 'setting-off',
      'A11 判定顺序：上游开关先于父状态（用户看到最上游那道闸）');
    eq(decideCreateDispatch({ ...base, parentExists: false }).reason, 'parent-missing', 'A12 准入同样认父任务缺失');

    eq(CREATE_DISPATCH_REASON_LABEL['parent-missing'], '父任务已不存在（结果无处可回）', 'A13 缺失理由说人话');
    eq(CREATE_DISPATCH_REASON_LABEL['parent-failed'], '父任务已失败（结果无处可回）', 'A14 失败理由说人话');
    eq(CREATE_DISPATCH_REASON_LABEL['parent-archived'], '父任务已归档（结果无处可回）', 'A15 归档理由说人话');
    eq(CREATE_DISPATCH_REASON_LABEL['parent-completed'], '父任务已完成（结果无处可回）', 'A16 完成理由说人话');

    const collab = readCode(`${A}/src/main/core/collab-dispatch.ts`);
    ok(!collab.includes("'has-parent'") && !Object.keys(CREATE_DISPATCH_REASON_LABEL).includes('has-parent'),
      'A17 旧理由 has-parent 已清零（词表与标签表皆无）');
    const orch = readCode(`${A}/src/main/core/orchestrator.ts`);
    ok(orch.includes('taskParentDispatchBlock(db, taskId)') && orch.includes("from './collab-dispatch.js'"),
      'A18 编排侧复用同一判据（不另写一套 SQL 规则）');

    const d = makeDb();
    insertTask(d, 'p-paused', '', 'paused');
    insertTask(d, 'c-ok', 'p-paused');
    eq(taskParentDispatchBlock(asBetter(d), 'c-ok'), null, 'A19 库里父任务暂停 ⇒ 子任务可派');
    d.prepare("UPDATE wa_tasks SET status = 'failed' WHERE id = 'p-paused'").run();
    eq(taskParentDispatchBlock(asBetter(d), 'c-ok'), 'parent-failed', 'A20 同一子任务，父改失败 ⇒ 改为拒（同判据）');
    insertTask(d, 'c-gone', 'p-missing');
    eq(taskParentDispatchBlock(asBetter(d), 'c-gone'), 'parent-missing', 'A21 父行不存在 ⇒ parent-missing');
    insertTask(d, 'c-root', '');
    eq(taskParentDispatchBlock(asBetter(d), 'c-root'), null, 'A22 无父任务 ⇒ 放行（不误拦根任务）');
  }
}

/* ═══ B selection 四处同值 ═════════════════════════════════════════════════ */
async function sectionB(): Promise<void> {
  console.log('\n【B】派单证据：事件 / 台账 / context / 详情同值，缺省不编造');
  {
    const selection = { layer: 'zone-a', net_gain: 12, reason: ' 同区低负载 ' };
    const d = enrolledDb();
    const captured: Array<{ type: string; data: Record<string, unknown> }> = [];
    const io = ioOf({ async submit() { return ansRequest({ id: 'rq-B1', target_node_id: 'n-a', selection }); } });
    const r = await dispatchNodeRequest(asBetter(d), { category: 'project_task', payload: { prompt: '写周报' } },
      { io, emit: recordingEmit(d, captured) });
    eq(r.selection, selection, 'B1 派发返回原样带回择机快照（不裁剪）');
    const dispatched = captured.find((e) => e.type === 'node.request_dispatched')!;
    eq(dispatched.data.selection, selection, 'B2 到场事件带同一份快照');
    const rec = listNodeDispatchRecords(asBetter(d)).find((x) => x.requestId === 'rq-B1')!;
    eq(rec.selection, selection, 'B3 台账聚合出同一份快照（读库，不读内存）');
    const audit = d.prepare("SELECT detail_json FROM wa_audit_events WHERE action = 'node.dispatch'").get() as { detail_json: string };
    eq(JSON.parse(audit.detail_json).selectionReason, '同区低负载', 'B4 审计只记人话短句（首尾空白已 trim）');
    eq(selectionReasonText(selection), '同区低负载', 'B5 selectionReasonText 取同一句');

    insertTask(d, 'T-B1');
    markRemoteAssigned(asBetter(d), 'T-B1', { nodeId: 'n-a', requestId: 'rq-B1' }, '2026-11-04T10:00:00.000Z',
      { category: 'project_task', selection });
    eq(remoteSelectionOf(ctxOf(d, 'T-B1')), selection, 'B6 context 里也是同一份');
    eq(remoteTaskView(ctxOf(d, 'T-B1'))?.selection, selection, 'B7 任务详情视图读同一份');
    markRemoteAssigned(asBetter(d), 'T-B1', { nodeId: 'n-a', requestId: 'rq-B2' }, '2026-11-04T10:01:00.000Z',
      { category: 'project_task', selection: null });
    eq(remoteSelectionOf(ctxOf(d, 'T-B1')), null, 'B8 明确没给（null）⇒ 清掉上一单旧理由');
    eq(remoteTaskView(ctxOf(d, 'T-B1'))?.selection, null, 'B9 详情同样如实为空（不拿旧证据说新派发）');
    markRemoteAssigned(asBetter(d), 'T-B1', { nodeId: 'n-a', requestId: 'rq-B3' }, '2026-11-04T10:02:00.000Z',
      { category: 'project_task' });
    eq(remoteSelectionOf(ctxOf(d, 'T-B1')), null, 'B10 不传 selection ⇒ 保持现状（不是清空也不是编造）');

    // 旧行 / 未给快照的派发事件 ⇒ 台账如实 null。
    d.prepare(`INSERT INTO wa_event_log (id, aggregate_type, aggregate_id, event_type, payload, occurred_at)
      VALUES ('ev-old', 'node_dispatch', 'rq-old', 'node.request_dispatched', ?, datetime('now'))`)
      .run(JSON.stringify({ category: 'project_task', targetNodeId: 'n-a' }));
    const oldRec = listNodeDispatchRecords(asBetter(d)).find((x) => x.requestId === 'rq-old')!;
    eq(oldRec.selection, null, 'B11 旧行无快照 ⇒ null（不编一个理由）');
    eq(selectionReasonText(null), '', 'B12 无快照 ⇒ 理由空串（界面据此说"未提供"）');
    eq(selectionReasonText({ reason: 42 }), '', 'B13 坏形状 ⇒ 空串（不做类型强转）');

    const missing = formatRemoteResultNotice({ requestId: 'rq-old', category: 'project_task', targetNodeId: 'n-a', status: 'done' });
    ok(missing.includes('派单理由未提供') && missing.includes('已完成'), 'B14 IM 收口通知：缺理由如实说"未提供"');
    const withReason = formatRemoteResultNotice({ requestId: 'rq-B1', category: 'project_task', targetNodeId: 'n-a', status: 'error', selection });
    ok(withReason.includes('派单理由：同区低负载') && withReason.includes('失败'), 'B15 IM 收口通知：有理由照抄，状态说人话');
    ok(formatRemoteResultNotice({ requestId: 'x', category: '', targetNodeId: '', status: 'cancelled' }).includes('已停止'),
      'B16 cancelled 不并入完成/失败（说"已停止"）');
  }
}

/* ═══ C 未认领回收 ═════════════════════════════════════════════════════════ */
async function sectionC(): Promise<void> {
  console.log('\n【C】未认领回收：pending + 超时 + 台账确认离线才收，别的一律不动');
  {
    const NOW = Date.parse('2026-11-04T12:00:00.000Z');
    const oldIso = new Date(NOW - 10 * 60 * 1000).toISOString();
    const recent = utcSec(NOW - 10_000);
    const offline = utcSec(NOW - 10 * 60 * 1000);
    // 生产顺序：派出去那一刻先记一记尝试账，结局再回填（`markRemoteAttemptResult` 只更新既有条目）。
    const assignedCtx = {
      assigned_node_id: 'n-a',
      assigned_request_id: 'rq-C',
      assigned_at: oldIso,
      remote_attempts: [{ nodeId: 'n-a', requestId: 'rq-C', at: oldIso, result: 'dispatched' }],
    };

    const seed = (): DatabaseSync => {
      const d = enrolledDb();
      insertTask(d, 'T-C', '', 'pending', assignedCtx);
      return d;
    };
    const drive = async (
      d: DatabaseSync,
      getStatus: AnsNodeRequest['status'],
      o: { cancel?: () => Promise<AnsNodeRequest>; listLedger?: () => Promise<{ localNodeId: string; nodes: AnsNode[]; error?: string }>; timeoutMs?: number } = {},
    ) => {
      let cancels = 0;
      let ledgerReads = 0;
      const ledger = o.listLedger
        ? async () => { ledgerReads++; return o.listLedger!(); }
        : undefined;
      const io = ioOf({
        async get() { return ansRequest({ id: 'rq-C', target_node_id: 'n-a', status: getStatus }); },
        async cancel() { cancels++; return o.cancel ? o.cancel() : ansRequest({ id: 'rq-C', target_node_id: 'n-a', status: 'cancelled' }); },
      });
      const out = await driveRemoteSubtasks(asBetter(d), {
        io,
        emit: () => true,
        enqueue: async () => '',
        now: () => NOW,
        timeoutMs: o.timeoutMs ?? 24 * 60 * 60 * 1000,
        ...(ledger ? { listLedger: ledger } : {}),
      });
      return { out, cancels, ledgerReads };
    };
    const offlineLedger = async () => ({
      localNodeId: 'n-self',
      nodes: [ansNode('n-self', { role: 'primary', last_seen_at: recent }), ansNode('n-a', { last_seen_at: offline })],
    });

    {
      const d = seed();
      const r = await drive(d, 'pending', { listLedger: offlineLedger });
      eq([r.out.checked, r.out.reclaimed, r.cancels, r.ledgerReads], [1, 1, 1, 1],
        'C1 pending 且超时且确认离线 ⇒ 收回（叫停 0→1，台账读 1 次）');
      const ctx = JSON.parse(ctxOf(d, 'T-C')) as Record<string, unknown>;
      ok(!('assigned_node_id' in ctx) && !('assigned_request_id' in ctx) && !('assigned_at' in ctx),
        'C2 收回即清外派三键（退回本机调度）');
      ok(typeof ctx.remote_reclaimed_at === 'string' && ctx.remote_reclaimed_at.length > 0, 'C3 收回时刻落盘（可追溯）');
      eq(statusOf(d, 'T-C'), 'pending', 'C4 不记失败：任务仍是 pending，由本机接手');
      eq(remoteAttemptsOf(ctxOf(d, 'T-C'))[0]?.result, 'reclaimed', 'C5 尝试账如实记 reclaimed');
      eq(remoteAttemptsOf(ctxOf(d, 'T-C'))[0]?.reason, 'target-offline-unclaimed', 'C6 收回原因可查');
      const note = noteOf(d, 'T-C');
      ok(note.includes('未认领收回') && note.includes(`${Math.round(REMOTE_UNCLAIMED_RECLAIM_MS / 1000)} 秒`),
        'C7 会话留痕说清"等了多久没人接 + 目标离线"');
    }
    {
      const d = seed();
      const r = await drive(d, 'assigned', { listLedger: offlineLedger });
      eq([r.out.reclaimed, r.cancels, r.ledgerReads], [0, 0, 0], 'C8 assigned（对端已在跑）⇒ 不回收，连台账都不读');
      eq(JSON.parse(ctxOf(d, 'T-C')).assigned_request_id, 'rq-C', 'C9 外派归属原样保留');
    }
    {
      const d = seed();
      const r = await drive(d, 'pending', { listLedger: async () => ({ localNodeId: 'n-self', nodes: [], error: 'boom' }) });
      eq([r.out.reclaimed, r.cancels], [0, 0], 'C10 台账读失败 ⇒ 确认不了就不动手');
    }
    {
      const d = seed();
      const r = await drive(d, 'pending', { listLedger: async () => { throw new Error('ledger-down'); } });
      eq([r.out.reclaimed, r.cancels], [0, 0], 'C11 台账抛异常 ⇒ 同样不动（不把异常当离线）');
      eq(JSON.parse(ctxOf(d, 'T-C')).assigned_request_id, 'rq-C', 'C12 归属仍在');
    }
    {
      const d = seed();
      const r = await drive(d, 'pending', { listLedger: async () => ({ localNodeId: 'n-self', nodes: [ansNode('n-bess', { last_seen_at: offline })] }) });
      eq(r.out.reclaimed, 0, 'C13 目标不在台账 ⇒ 不回收（读不到 ≠ 离线）');
    }
    {
      const d = seed();
      const r = await drive(d, 'pending');
      eq([r.out.reclaimed, r.cancels], [0, 0], 'C14 没注入台账源（老调用方）⇒ 不回收，行为不变');
    }
    {
      const d = seed();
      const r = await drive(d, 'pending', {
        listLedger: offlineLedger,
        cancel: async () => { throw new Error('cancel-down'); },
      });
      eq([r.out.reclaimed, r.cancels], [0, 1], 'C15 叫停失败 ⇒ 不谎称已收回（仍保留归属）');
      eq(JSON.parse(ctxOf(d, 'T-C')).assigned_request_id, 'rq-C', 'C16 归属未被清掉');
    }
    {
      const d = seed();
      const r = await drive(d, 'pending', {
        listLedger: offlineLedger,
        cancel: async () => ansRequest({ id: 'rq-C', target_node_id: 'n-a', status: 'assigned' }),
      });
      eq(r.out.reclaimed, 0, 'C17 ANS 未置 cancelled ⇒ 不回收（只认真停）');
    }
    {
      const d = seed();
      const r = await drive(d, 'pending', {
        listLedger: async () => ({ localNodeId: 'n-self', nodes: [ansNode('n-a', { last_seen_at: recent })] }),
      });
      eq(r.out.reclaimed, 0, 'C18 目标仍在线 ⇒ 不回收（再等它接）');
    }
    {
      const d = seed();
      const r = await drive(d, 'pending', { timeoutMs: 1000 });
      eq([r.out.reclaimed, r.cancels], [1, 0], 'C19 15 分钟超时兜底仍在（未认领回收是加法，不替换旧路）');
      eq(remoteAttemptsOf(ctxOf(d, 'T-C'))[0]?.result, 'timeout', 'C20 超时如实记 timeout（不夸成 reclaimed）');
    }
  }
}

/* ═══ D 授权台 ═════════════════════════════════════════════════════════════ */
function sectionD(): void {
  console.log('\n【D】IM 授权台：三类聚合、计数、文案、授予闸与收窄动作');
  {
    const d = makeDb();
    const insT = d.prepare(`INSERT INTO wa_external_terminals
      (id, name, status, pair_code, key_prefix, secret_hash, capabilities_json, last_remote_addr, last_seen_at, source, created_at, approved_at)
      VALUES (?, ?, ?, ?, '', '', '[]', ?, '2026-11-04 10:00:00', ?, '2026-11-04 10:00:00', ?)`);
    insT.run('t-lan', '书房终端', 'pending', '111111', '192.168.1.9', 'lan', null);
    insT.run('t-remote', '客厅平板', 'pending', '222222', '10.0.0.8', 'remote', null);
    insT.run('t-done', '旧终端', 'approved', '', '192.168.1.5', 'remote', '2026-11-01 10:00:00');

    const light = dev({ id: 'd-light', name: '客厅主灯', room: '客厅', kind: 'light', kind_class: 'light', controllable: true, last_seen: '2026-11-04 11:00:00' });
    const aircon = dev({ id: 'd-air', name: '客厅空调', room: '客厅', kind: 'aircon', kind_class: 'aircon', controllable: true, last_seen: '2026-11-04 10:59:00' });
    const lock = dev({ id: 'd-lock', name: '入户门锁', kind: 'lock', kind_class: 'lock', controllable: true, last_seen: '2026-11-04 10:58:00' });
    const sensor = dev({ id: 'd-sensor', name: '温湿度计', kind: 'sensor', kind_class: 'sensor', controllable: false, last_seen: '2026-11-04 10:57:00' });
    const authorized = dev({ id: 'd-on', name: '已授权灯', kind: 'light', kind_class: 'light', controllable: true, authorized: true, last_seen: '2026-11-04 10:56:00' });
    for (const x of [light, aircon, lock, sensor, authorized]) insertDevice(d, x);

    const ev = d.prepare(`INSERT INTO wa_event_log (id, aggregate_type, aggregate_id, event_type, payload, occurred_at)
      VALUES (?, 'node_dispatch', ?, ?, ?, datetime('now'))`);
    // 台账按 `id ASC` 归并（生产 id 是 UUID，先后由插入序决定）——夹具 id 也须按事发先后排。
    ev.run('q1-e1', 'rq-q1', 'node.request_dispatched', JSON.stringify({ category: 'project_task', targetNodeId: 'n-a' }));
    ev.run('q1-e2', 'rq-q1', 'node.request_question', JSON.stringify({ question: '用哪个模板？', options: ['周报', '日报'] }));
    ev.run('q2-e1', 'rq-q2', 'node.request_dispatched', JSON.stringify({ category: 'project_task', targetNodeId: 'n-a' }));
    ev.run('q2-e2', 'rq-q2', 'node.request_question', JSON.stringify({ question: '已经答过的问题' }));
    ev.run('q2-e3', 'rq-q2', 'node.request_answered', JSON.stringify({ answer: '用周报' }));

    const inbox = buildApprovalInbox(asBetter(d));
    eq([inbox.terminals.length, inbox.devices.length, inbox.questions.length], [2, 2, 1],
      'D1 三类各归其位：待接入 2 / 待授权 2 / 待答 1（已答与高危/只读/已授权均不入台）');
    eq(inbox.devices.map((x) => x.id).sort(), ['d-air', 'd-light'], 'D2 待授权设备恰是两台可控、未授权、非高危');
    eq(inbox.questions[0]?.requestId, 'rq-q1', 'D3 待答问题只取 asked 的那一单');

    ok(formatTerminalList(inbox.terminals).startsWith('待接入终端（2）'), 'D4 终端清单头带计数');
    ok(formatDeviceList(inbox.devices).startsWith('待授权设备（2）'), 'D5 设备清单头带计数');
    ok(formatQuestionList(inbox.questions).startsWith('待答问题（1）'), 'D6 问题清单头带计数');
    const full = formatApprovalInbox(inbox);
    ok(['待接入终端（2）', '待授权设备（2）', '待答问题（1）', '「同意接入 <核对码>」', '「允许设备 <码>」', '「回答 <码> <答案>」']
      .every((s) => full.includes(s)), 'D7 三段同列 + 五种回复口令同屏');
    ok(formatTerminalCandidate(inbox.terminals.find((t) => t.id === 't-lan')!).includes('局域网发现'),
      'D8 局域网来源如实标注（与远端区分）');
    ok(formatTerminalList(inbox.terminals, 1).includes('…还有 1 台'), 'D9 超限引导"看全部"');

    const empty = makeDb();
    eq(formatApprovalInbox(buildApprovalInbox(asBetter(empty))),
      '当前没有待接入的终端、待授权的设备，也没有待答的跨机问题。',
      'D10 只有三类皆空才说"没有待办"（名实相符）');

    ok(String(deviceActionRefusal(lock, 'allow')).includes('高危'), 'D11 高危设备在 IM 内永不授权');
    ok(String(deviceActionRefusal(sensor, 'allow')).includes('只读设备'), 'D12 只读设备授权有可行动拒因');
    ok(String(deviceActionRefusal(authorized, 'allow')).includes('已授权'), 'D13 重复授权如实说无需重复');
    eq(deviceActionRefusal(authorized, 'deny'), null, 'D14 已授权设备可撤回（deny 合法）');
    ok(String(deviceActionRefusal(light, 'deny')).includes('本就是只读'), 'D15 未授权设备 deny 无需动作');

    const approvalIpc = readCode(`${A}/src/main/ipc/approval.ipc.ts`);
    ok(approvalIpc.includes("'approval:inbox'"), 'D16 授权台只读出口在册');
    ok(['external_terminal', 'approval_inbox', 'device_control', 'multi_node'].every((k) => approvalIpc.includes(k)),
      'D17 三类计数各读各的团队闸（终端/设备/跨机问题）');

    const external = readCode(`${A}/src/main/ipc/external.ipc.ts`);
    const approve = handlerBody(external, 'external:approve');
    ok(approve.includes('teamFeatureRefusal') && approve.includes('external_terminal') && approve.includes('approval_inbox'),
      'D18 授予动作过两把闸（外部终端 + IM 授权台）');
    ok(['external:reject', 'external:revoke', 'external:reissue']
      .every((c) => !handlerBody(external, c).includes('teamFeatureRefusal')),
      'D19 收窄动作无闸（拒绝/撤回/重签不能被档位挡住）');

    const devicesIpc = readCode(`${A}/src/main/ipc/devices.ipc.ts`);
    const authorize = handlerBody(devicesIpc, 'devices:authorize');
    ok(authorize.includes('teamFeatureRefusal') && authorize.includes('device_control'),
      'D20 设备授权过团队版控制闸');
    ok(['devices:rename', 'devices:set_room'].every((c) => !handlerBody(devicesIpc, c).includes('teamFeatureRefusal')),
      'D21 改名/改房间属收窄动作，不受档位影响');
  }
}

/* ═══ E 离家场景 ═══════════════════════════════════════════════════════════ */
async function sectionE(): Promise<void> {
  console.log('\n【E】离家：只关灯/空调/风扇、合窗帘；高危与开关不猜；绝不调模型');
  {
    const light1 = dev({ id: 'd1', name: '客厅主灯', room: '客厅', kind: 'light', kind_class: 'light', controllable: true, authorized: true });
    const light2 = dev({ id: 'd2', name: '客厅落地灯', room: '客厅', kind: 'light', kind_class: 'light', controllable: true, authorized: true });
    const bedroomLight = dev({ id: 'd3', name: '卧室灯', room: '卧室', kind: 'light', kind_class: 'light', controllable: true, authorized: true });
    const aircon = dev({ id: 'd4', name: '客厅空调', room: '客厅', kind: 'aircon', kind_class: 'aircon', controllable: true, authorized: true });
    const fan = dev({ id: 'd5', name: '客厅风扇', room: '客厅', kind: 'fan', kind_class: 'fan', controllable: true, authorized: false });
    const curtain = dev({ id: 'd6', name: '客厅窗帘', room: '客厅', kind: 'curtain', kind_class: 'curtain', controllable: true, authorized: true });
    const plug = dev({ id: 'd7', name: '客厅插座', room: '客厅', kind: 'switch', kind_class: 'switch', controllable: true, authorized: true });
    const doorLock = dev({ id: 'd8', name: '入户门锁', room: '客厅', kind: 'lock', kind_class: 'lock', controllable: true, authorized: true });
    const all = [light1, light2, bedroomLight, aircon, fan, curtain, plug, doorLock];

    const away = planHomeAway(all);
    ok(away.ok, 'E1 全屋离家可排出计划');
    const steps = away.ok ? away.steps : [];
    eq(steps.map((s) => s.call_name), ['客厅主灯', '客厅落地灯', '卧室灯', '客厅空调', '客厅窗帘'],
      'E2 只动四类角色（灯→空调→风扇→窗帘固定序），开关/门锁不猜');
    eq(steps.map((s) => s.action), ['turn_off', 'turn_off', 'turn_off', 'turn_off', 'close'],
      'E3 灯/空调/风扇=关，窗帘=合');
    eq((away.skipped ?? []).map((s) => s.call_name), ['客厅风扇'], 'E4 未授权风扇进 skipped 而不是计划');
    ok(String((away.skipped ?? [])[0]?.reason).includes('尚未授权控制'), 'E5 跳过原因取 K-6 判据（不另写一句）');

    const livingRoom = planHomeAway(all, '客厅');
    eq(livingRoom.ok ? livingRoom.steps.map((s) => s.call_name) : [], ['客厅主灯', '客厅落地灯', '客厅空调', '客厅窗帘'],
      'E6 单房间只取该房间（卧室灯不混进来）');
    const bedroom = planHomeAway(all, '卧室');
    eq(bedroom.ok ? bedroom.steps.map((s) => s.call_name) : [], ['卧室灯'], 'E7 房间匹配是精确相等，不是子串/模糊');

    const unauthorizedOnly = planHomeAway([dev({ id: 'x', name: '书房灯', room: '书房', kind: 'light', kind_class: 'light', controllable: true, authorized: false })], '书房');
    eq([unauthorizedOnly.ok, unauthorizedOnly.reason], [false, 'no_controllable_device'], 'E8 全被 K-6 拒 ⇒ 失败原因可行动');
    eq(planHomeAway([]).reason, 'no_devices', 'E9 无设备 ⇒ no_devices');
    eq(planHomeAway([dev({ id: 'u', kind_class: 'unknown' })]).reason, 'no_recognized_kind', 'E10 品类全未知 ⇒ 不猜');

    let modelCalls = 0;
    const deps = {
      listDevices: () => all,
      modelPlan: async () => { modelCalls++; return { ok: true as const, steps: [{ call_name: 'model-said', action: 'turn_off' }] }; },
    };
    const resolved = await resolveHomeIntent({ intent: HOME_AWAY_INTENT, params: {} }, deps);
    eq([resolved.ok, resolved.source, modelCalls], [true, 'rule', 0], 'E11 离家只走规则：即使注入了模型规划器也零调用');
    const roomResolved = await resolveHomeIntent({ intent: HOME_AWAY_INTENT, params: { room: '客厅' } }, deps);
    ok(roomResolved.ok && !roomResolved.steps.some((s) => s.call_name === '卧室灯'), 'E12 离家的 room 参与过滤');
    const unknown = await resolveHomeIntent({ intent: 'home.unknown', params: {} }, deps);
    ok(!unknown.ok && unknown.reason === 'unknown_intent' && String(unknown.message).includes(HOME_AWAY_INTENT),
      'E13 未知意图如实报，并把可用的意图名说给用户');

    const intents = publicIntents();
    eq(intents.map((i) => i.id), ['home.comfort', HOME_AWAY_INTENT], 'E14 门外协议恰两条（不虚报未落地意图）');
    const awaySpec = intents.find((i) => i.id === HOME_AWAY_INTENT)!;
    eq(awaySpec.params.map((p) => [p.key, p.required]), [['room', false]], 'E15 离家只有可选 room（省略＝全屋）');

    const v1 = validateIntent({ intent: HOME_AWAY_INTENT, params: { room: ' 客厅 ' } });
    eq(v1.ok ? v1.params : null, { room: '客厅' }, 'E16 协议校验：离家 room 可省可填，值做 trim');
    const v2 = validateIntent({ intent: HOME_AWAY_INTENT, params: { feeling: 'hot' } });
    ok(!v2.ok && v2.body.errors?.some((e) => e.includes('feeling')), 'E17 离家不接受 comfort 私有参数（词表只回意图内参数）');
    const v3 = validateIntent({ intent: 'home.unknown', params: {} });
    ok(!v3.ok && v3.body.error === 'unknown_intent' && v3.body.allowed.includes(HOME_AWAY_INTENT),
      'E18 未知意图回允许清单');
  }
}

/* ═══ F 渠道配置闸 ═════════════════════════════════════════════════════════ */
function sectionF(): void {
  console.log('\n【F】渠道配置写入闸：没升级就别存一份假配置');
  {
    const community = { proUnlocked: false, teamUnlocked: false, tierLabel: '社区版' };
    const pro = { proUnlocked: true, teamUnlocked: false, tierLabel: '专业版' };
    const nonEmpty = channelSettingRefusal('device.mqtt.broker', community, 'mqtt.local');
    ok(nonEmpty !== null, 'F1 社区档写 MQTT 地址 ⇒ 拒');
    ok(['专业版', '设备发现（只读台账）', 'MQTT 网关', '未升级前不保存', '清空不受影响'].every((s) => String(nonEmpty).includes(s)),
      'F2 拒因说清哪档哪项能力，并明确清空不受影响');
    eq(channelSettingRefusal('device.mqtt.broker', community, ''), null, 'F3 清空永远允许（历史残留清得掉）');
    eq(channelSettingRefusal('device.mqtt.broker', community, '   '), null, 'F4 纯空白视同清空');
    eq(channelSettingRefusal('device.mqtt.broker', pro, 'mqtt.local'), null, 'F5 Pro 档放行');
    eq(channelSettingRefusal('ui.theme', community, 'dark'), null, 'F6 非设备键不受影响（闸只认渠道登记）');

    eq(channelSettingTier('device.mqtt.broker'), 'pro', 'F7 MQTT 网关归专业版（静态判定不看当前证）');
    eq(channelSettingTier('ui.theme'), null, 'F8 非设备键无归属');
    eq(channelSettingOwner('device.mqtt.broker')?.id, 'mqtt', 'F9 设置键能找回所属渠道');
    ok(channelSettingTier('device.tuya.access_secret') === 'pro', 'F10 涂鸦云凭据同样归专业版');

    const admin = readCode(`${A}/src/main/ipc/admin.ipc.ts`);
    const body = handlerBody(admin, 'settings:set');
    const gateAt = body.indexOf('channelSettingRefusal(');
    const writeAt = body.indexOf("INSERT OR REPLACE INTO wa_settings");
    ok(gateAt >= 0 && writeAt > gateAt, 'F11 settings:set 先过渠道闸再落库（不先写半截）');
    ok(body.includes("'PRO_REQUIRED'") && body.includes("'TEAM_REQUIRED'"), 'F12 拒因按归属档位分码');
  }
}

/* ═══ G 档位卖点与闸 ═══════════════════════════════════════════════════════ */
function sectionG(): void {
  console.log('\n【G】卖点与闸一一对应；价目表与文档同句');
  {
    for (const tier of ['community', 'pro', 'team'] as const) {
      eq(benefitCoverageProblems(tier, PRICING[tier].benefits), [], `G-${tier} 本档卖点逐条有兑现（双向登记一致）`);
    }
    const fake = [...PRICING.team.benefits, '凭空一句卖点'];
    ok(benefitCoverageProblems('team', fake).some((p) => p.includes('未登记兑现方式')), 'G1 塞一句无闸卖点 ⇒ 被点名');
    const removed = PRICING.team.benefits.filter((b) => b !== '跨机子任务（完成后自动恢复父任务）');
    ok(benefitCoverageProblems('team', removed).some((p) => p.includes('已登记但价目表没有这句')),
      'G2 登记了却不卖 ⇒ 同样被点名（防登记腐化）');

    const cross = '跨机子任务（完成后自动恢复父任务）';
    const away = '设备场景（离家：关灯 / 关空调 / 合帘）';
    ok(PRICING.team.benefits.includes(cross) && PRICING.team.benefits.includes(away), 'G3 本轮两句卖点都在价目表');
    eq(BENEFIT_COVERAGE.team.find((e) => e.benefit === cross)?.target, { kind: 'capability', keys: ['multi_node'] },
      'G4 跨机子任务指回 multi_node 真闸');
    eq(BENEFIT_COVERAGE.team.find((e) => e.benefit === away)?.target, { kind: 'capability', keys: ['device_control'] },
      'G5 离家场景指回 device_control 真闸');
    eq(TEAM_FEATURE_LABEL.approval_inbox, 'IM 授权台（设备授权 / 跨机问答 / 终端接入）',
      'G6 授权台人话名取能力表单一真源');
    ok(PRICING.team.benefits.includes(TEAM_FEATURE_LABEL.approval_inbox), 'G7 价目表同引这一句（不另抄）');

    const doc = readText('business-plan/license-tiers.md');
    ok(doc.includes(cross) && doc.includes(away), 'G8 商业化文档与价目表同句（不各说各的）');
  }
}

/* ═══ H 静态钉与套件自检 ═══════════════════════════════════════════════════ */
function sectionH(): void {
  console.log('\n【H】接线静态钉与套件自检');
  {
    checkBuildPins(ok, { distDir: path.join(ROOT, `${A}/dist`) });
    ok(ROUND_RE.test(SELF_ROUND), 'H-1 本轮标识由载体自身派生且格式合法', SELF_ROUND);
    ok(fs.existsSync(path.join(ROOT, `plans/improve/${SELF_ROUND}.md`)), `H-2 本轮方案在册：plans/improve/${SELF_ROUND}.md`);

    const ipc = readCode(`${A}/renderer/src/lib/ipc.ts`);
    ok(ipc.includes("ipcCall<ApprovalInboxPayload>('approval:inbox')"), 'H-3 renderer 的 approvalApi.inbox 真调 approval:inbox');
    const nav = readCode(`${A}/renderer/src/lib/navConfig.ts`);
    ok(nav.includes("to: '/inbox'") && nav.includes("label: '授权台'"), 'H-4 导航有 /inbox「授权台」');
    const app = readCode(`${A}/renderer/src/App.tsx`);
    ok(app.includes('path="/inbox"') && app.includes('<InboxPage'), 'H-5 路由挂了 /inbox');
    const layout = readCode(`${A}/renderer/src/components/AppLayout.tsx`);
    ok(layout.includes("to === '/inbox'") && layout.includes('approvalApi.inbox()'), 'H-6 角标与页面同源取数');
    const page = readCode(`${A}/renderer/src/pages/InboxPage.tsx`);
    ok(page.includes('approvalApi.inbox()'), 'H-7 授权台页面用同一出口');

    const selfLines = stripKeepingLines(fs.readFileSync(__filename, 'utf-8'));
    const dud = selfLines
      .map((line, i) => ({ line, i }))
      .filter(({ line }) => /(?:eq\([^,)]*,\s*|===?\s*|!==?\s*)'zx_\d{8}(?:_\d+)?'/.test(line));
    ok(dud.length === 0, 'H-8 本套件无「只为下一轮」字面量', dud.map((x) => `${x.i + 1}:${x.line.trim()}`).join(' | '));

    const selfText = fs.readFileSync(__filename, 'utf-8');
    const badGlyphs = [0x2717, 0x2713].map((c) => String.fromCodePoint(c));
    ok(!badGlyphs.some((g) => selfText.includes(g)), 'H-9 本套件文案无失败/通过字形（全量汇总器按失败字形计数）');
    ok(/通过 \/ .*失败/.test(selfText), 'H-10 收尾行如实印出断言数（通过 / 失败）');
  }
}

async function main(): Promise<void> {
  console.log(`rr_${SELF_ROUND} 受控回归（联：派得出去，也收得回来）`);
  sectionA();
  await sectionB();
  await sectionC();
  sectionD();
  await sectionE();
  sectionF();
  sectionG();
  sectionH();
  console.log(`\n${fail === 0 ? 'OK' : 'FAIL'} rr_${SELF_ROUND}: ${pass} 通过 / ${fail} 失败\n`);
}

void main()
  .then(() => process.exit(fail === 0 ? 0 : 1))
  .catch((e: unknown) => {
    console.error(`rr_${SELF_ROUND} 未捕获异常（复跑未跑完，不得读作通过）：`, e);
    console.log(`\nFAIL rr_${SELF_ROUND}: ${pass} 通过 / ${fail + 1} 失败\n`);
    process.exit(1);
  });
