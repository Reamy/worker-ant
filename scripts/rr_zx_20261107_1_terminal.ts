/**
 * zx_20261107_1「实·通·信」B2b 受控回归 —— AI 终端接入兑现（端到端一条链）。
 *
 * 口径（罗尔斯·无知之幕 / 维特根斯坦·意义即用法 / 王阳明·知行合一）：
 *   A 门牌只说"屋里有哪几类设备"（类目+数量），**不说**实例名/房间/地址/协议；
 *   B 进门=申请 → 人在 IM 回一句话批 → 凭据只经轮询**送达一次**（库中只存 hash）；
 *   C 进门后 `GET /capabilities` 只回脱敏五样，看得见"我被给了什么"，看不见没被给的；
 *   D 意图两跳：resolve **零副作用**落计划，execute **只执行一次**、逐步对账；
 *   E 离家只走规则；全屋次序与房间限定两侧标本；
 *   F 原始动作须显式授予；未授予/不可直调/烂请求三态各回各因、被拒也留痕。
 *
 * 纪律：零网络 / 零 electron / 零墙钟（注入 nowRef）；夹具按生产 DDL 同形、`node:sqlite` 内存库。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  AGENT_CARD_FIELDS,
  INBOUND_CAPABILITIES_PATH,
  INBOUND_INTENT_EXECUTE_PATH,
  INBOUND_INTENT_RESOLVE_PATH,
  INBOUND_INVOKE_PATH,
  INBOUND_WELL_KNOWN_PATH,
  buildAgentCard,
  handleInboundRequest,
  type InboundDeps,
} from '../apps/worker-ant-desktop/src/main/core/inbound-gate.js';
import {
  __resetTerminalSecretsForTest,
  approveTerminal,
  buildPairNotice,
  createPairRequest,
  createPairingPort,
  pairStatus,
  parsePairReply,
  resolvePairTarget,
  verifyTerminal,
  type TerminalDb,
} from '../apps/worker-ant-desktop/src/main/core/external-terminals.js';
import {
  DEFAULT_TERMINAL_CAPABILITIES,
  EXTERNAL_CAPABILITIES,
  createExternalCapabilityPort,
  listExternalCalls,
  type ExternalCapabilityPort,
} from '../apps/worker-ant-desktop/src/main/core/external-calls.js';
import { createHomeIntentResolver } from '../apps/worker-ant-desktop/src/main/core/home-intent.js';
import { HOME_AWAY_INTENT, HOME_COMFORT_INTENT } from '../apps/worker-ant-desktop/src/main/core/intent-protocol.js';
import { LICENSE_SETTING_KEYS } from '../apps/worker-ant-desktop/src/main/core/license.js';
import type { AnsDevice, DeviceControlOutcome } from '../apps/worker-ant-desktop/src/main/core/device-registry.js';
import { stripKeepingLines } from './lib/rr-pins.js';

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  PASS ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}
function eq(actual: unknown, expect: unknown, label: string): void {
  const a = JSON.stringify(actual); const e = JSON.stringify(expect);
  ok(a === e, label, `${a} vs ${e}`);
}

const root = path.join(__dirname, '..');
const A = 'apps/worker-ant-desktop';
const CODE = (rel: string) => stripKeepingLines(fs.readFileSync(path.join(root, rel), 'utf-8')).join('\n');

/* ── 夹具（生产 DDL 同形；三态齐：设置 / 留痕 / 终端 / 计划 / 动作） ───────── */
const TERMINAL_DDL = `CREATE TABLE wa_external_terminals (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  pair_code TEXT NOT NULL,
  key_prefix TEXT,
  secret_hash TEXT,
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  last_remote_addr TEXT,
  last_seen_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  approved_at TEXT,
  revoked_at TEXT,
  delivered_at TEXT,
  grant_expires_at TEXT,
  source TEXT,
  card_intents_json TEXT
)`;

function makeDoorDb(): DatabaseSync {
  const d = new DatabaseSync(':memory:');
  d.exec(`CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')))`);
  d.exec(`CREATE TABLE wa_external_calls (
    id TEXT PRIMARY KEY,
    terminal_id TEXT NOT NULL,
    capability TEXT NOT NULL,
    args_json TEXT DEFAULT '{}',
    result TEXT DEFAULT '',
    reason TEXT DEFAULT '',
    remote_addr TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  d.exec(TERMINAL_DDL);
  d.exec(`CREATE TABLE wa_intent_plans (
    id TEXT PRIMARY KEY,
    terminal_id TEXT NOT NULL,
    capability TEXT NOT NULL,
    params_json TEXT NOT NULL DEFAULT '{}',
    plan_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'planned',
    created_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    executed_at TEXT,
    result_json TEXT NOT NULL DEFAULT '{}',
    source TEXT NOT NULL DEFAULT 'rule'
  )`);
  d.exec(`CREATE TABLE wa_device_actions (
    id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL,
    action TEXT NOT NULL,
    args_json TEXT DEFAULT '{}',
    result TEXT DEFAULT '',
    task_id TEXT DEFAULT '',
    actor_kind TEXT DEFAULT '',
    actor_ref TEXT DEFAULT '',
    plan_id TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  // 试用期＝团队档能力（`external_terminal` 闸读这一处；与生产首次启动同态）。
  d.prepare('INSERT INTO wa_settings (key, value) VALUES (?, ?)')
    .run(LICENSE_SETTING_KEYS.trialStartedAt, new Date().toISOString());
  return d;
}

/** 设备标本：地址**刻意**取一个不会与门牌 url 重合的私网值（泄漏判据才咬得住）。 */
function dev(over: Partial<AnsDevice> & { id: string; name: string; kind: string }): AnsDevice {
  return {
    id: over.id,
    name: over.name,
    alias: over.alias ?? '',
    room: over.room ?? '客厅',
    kind: over.kind,
    kind_class: over.kind_class ?? '',
    protocol: over.protocol ?? 'mqtt',
    address: over.address ?? '10.20.30.40',
    port: over.port ?? 1883,
    capabilities: over.capabilities ?? ['turn_on', 'turn_off'],
    controllable: over.controllable ?? true,
    authorized: over.authorized ?? true,
    status: over.status ?? null,
    first_seen: '',
    last_seen: '',
    ...(over.desired !== undefined ? { desired: over.desired } : {}),
  } as AnsDevice;
}

const DEVICES: AnsDevice[] = [
  dev({ id: 'dev-curtain', name: '客厅窗帘', kind: 'cover', capabilities: ['open', 'close'] }),
  dev({ id: 'dev-aircon', name: '客厅空调', kind: 'climate', capabilities: ['set_temperature', 'turn_off'] }),
  dev({ id: 'dev-light', name: '客厅灯', kind: 'light' }),
  dev({ id: 'dev-fan', name: '客厅风扇', kind: 'fan' }),
  dev({ id: 'dev-bed-light', name: '卧室灯', kind: 'light', room: '卧室' }),
  dev({ id: 'dev-sensor', name: '客厅温湿度', kind: 'sensor', capabilities: [] }),
  dev({ id: 'dev-mystery', name: '神秘设备', kind: 'mystery', controllable: false }),
];

/** 设备传动探针：记调用（含身份/计划号），可选写一行 `wa_device_actions`（照生产装配层同形）。 */
function makeProbe(db?: DatabaseSync): {
  calls: Array<{ name?: string; deviceId?: string; action: string; args?: Record<string, unknown>; terminalId?: string; planId?: string }>;
  control: (inner: { name?: string; deviceId?: string; action: string; args?: Record<string, unknown>; terminalId?: string; planId?: string }) => Promise<DeviceControlOutcome>;
} {
  const calls: Array<{ name?: string; deviceId?: string; action: string; args?: Record<string, unknown>; terminalId?: string; planId?: string }> = [];
  let seq = 0;
  return {
    calls,
    control: async (inner) => {
      calls.push(inner);
      if (db) {
        db.prepare(`INSERT INTO wa_device_actions (id, device_id, action, args_json, result, actor_kind, actor_ref, plan_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
          `act-${++seq}`, 'dev-x', inner.action, JSON.stringify(inner.args ?? {}), 'ok', 'external', inner.terminalId ?? '', inner.planId ?? '',
        );
      }
      return { ok: true, deviceId: 'dev-x', action: inner.action, result: `已执行 ${inner.action}` };
    },
  };
}

const bearer = (cred: { key: string; secret: string }) => ({ authorization: `Bearer ${cred.key}.${cred.secret}` });

function pairAndApprove(d: DatabaseSync, caps: string[]): { pairingId: string; key: string; secret: string } {
  const tdb = d as unknown as TerminalDb;
  const { pairingId, pairCode } = createPairRequest(tdb, '隔壁的终端');
  const r = approveTerminal(tdb, pairingId, caps);
  if (!r.ok) throw new Error(`批准失败：${r.reason}`);
  const st = pairStatus(tdb, pairingId, pairCode);
  if (st.status !== 'approved' || !st.credentials) throw new Error('凭据未取回');
  return { pairingId, key: st.credentials.key, secret: st.credentials.secret };
}

const planRows = (d: DatabaseSync) => Number((d.prepare('SELECT COUNT(*) AS n FROM wa_intent_plans').get() as { n: number }).n);
const actionRows = (d: DatabaseSync) => Number((d.prepare('SELECT COUNT(*) AS n FROM wa_device_actions').get() as { n: number }).n);
const planStatus = (d: DatabaseSync, id: string) => (d.prepare('SELECT status FROM wa_intent_plans WHERE id = ?').get(id) as { status: string }).status;

async function main(): Promise<void> {
  // ═══ A｜门牌：类目公开、实例遮蔽（罗尔斯·无知之幕）═══════════════════════
  console.log('\n【A】门牌的设备能力摘要');
  {
    const card = buildAgentCard('阳台的工蚁', '0.5.0', 'http://192.168.1.10:27184', DEVICES);
    eq(Object.keys(card), [...AGENT_CARD_FIELDS], 'A1 门牌键集合**精确**（多一个键就是把门内之物摆到街上）');
    eq(card.device_categories, [
      { class: 'curtain', label: '窗帘', count: 1 },
      { class: 'aircon', label: '空调', count: 1 },
      { class: 'light', label: '灯', count: 2 },
      { class: 'fan', label: '风扇', count: 1 },
      { class: 'sensor', label: '传感器', count: 1 },
    ], 'A2 ★类目+数量，按词表序；`unknown` 不入清单');
    const text = JSON.stringify(card);
    ok(!text.includes('客厅窗帘') && !text.includes('卧室灯') && !text.includes('客厅空调'),
      'A3 ★设备实例名不出门');
    ok(!text.includes('"客厅"') && !text.includes('"卧室"'), 'A4 ★房间实例值不出门');
    ok(!text.includes('10.20.30.40'), 'A5 ★网络坐标（设备地址）不出门');
    ok(!text.includes('node_id'), 'A6 不暴露本机节点标识');
    eq(card.intents.map((i) => i.id), [HOME_COMFORT_INTENT, HOME_AWAY_INTENT], 'A7 意图目录恰两条');
    eq(card.offered_capabilities.map((c) => c.key), [...EXTERNAL_CAPABILITIES], 'A8 能力门类与白名单同源');
    ok(card.offered_capabilities.every((c) => c.requires_approval === true), 'A9 门类一律须审批后才可用');

    // 0→1 正面断言：没有设备 ⇒ 0 类；有设备 ⇒ 非空。
    const empty = buildAgentCard('空的工蚁', '0.5.0', null, []);
    eq(empty.device_categories, [], 'A10 无设备 ⇒ 0 类（正面 0 侧）');
    ok(card.device_categories.length > 0, 'A11 ★0→1：有设备 ⇒ 类目非空');

    // 门路由：私网得门牌；非私网连门牌都看不到（围栏先于一切）。
    const deps: InboundDeps = {
      nodeName: () => '阳台的工蚁',
      agentVersion: '0.5.0',
      cardUrl: 'http://192.168.1.10:27184',
      listDevices: () => DEVICES,
    };
    const hit = await handleInboundRequest(
      { method: 'GET', path: INBOUND_WELL_KNOWN_PATH, headers: {}, remoteAddress: '192.168.1.44' }, deps,
    );
    eq(hit.status, 200, 'A12 私网访客 `GET /.well-known/agent.json` ⇒ 200（免凭据）');
    eq((hit.body as { device_categories?: unknown }).device_categories, card.device_categories,
      'A13 ★门路由与 `buildAgentCard` 同一份组装（不是第二套门牌）');
    const outside = await handleInboundRequest(
      { method: 'GET', path: INBOUND_WELL_KNOWN_PATH, headers: {}, remoteAddress: '8.8.8.8' }, deps,
    );
    eq(outside.status, 403, 'A14 ★非私网 ⇒ 403（围栏先于门牌）');
  }

  // ═══ B｜进门：申请 → IM 一句话批 → 凭据送达一次 ═══════════════════════════
  console.log('\n【B】配对与 IM 审批');
  {
    const notice = buildPairNotice({ name: '机器人小七', pairCode: '424242' });
    ok(notice.includes('同意接入 424242') && notice.includes('拒绝接入 424242'),
      'B1 ★通知里的两条命令与解析器同形（照抄即可用）');
    ok(notice.includes('意图控制'), 'B2 通知如实说明"获准后授予意图控制"');

    eq(parsePairReply('同意接入 424242'), { kind: 'approve', code: '424242' }, 'B3a 批准句');
    eq(parsePairReply('拒绝接入 424242'), { kind: 'reject', code: '424242' }, 'B3b 拒绝句');
    eq(parsePairReply('同意接入'), { kind: 'approve', code: null }, 'B3c 无码也认（靠"恰一条待批"定目标）');
    eq(parsePairReply('同意'), null, 'B3d ★裸「同意」不被吃掉（留给任务审批路）');

    __resetTerminalSecretsForTest();
    const db = makeDoorDb();
    const tdb = db as unknown as TerminalDb;
    const { pairingId, pairCode } = createPairRequest(tdb, '机器人小七', '192.168.1.77');
    const wrong = pairCode === '999999' ? '888888' : '999999';
    eq(pairStatus(tdb, pairingId, wrong), { status: 'unknown' }, 'B4a ★错码一律 unknown（不泄露"这单存在"）');
    eq(pairStatus(tdb, pairingId, pairCode), { status: 'pending' }, 'B4b 正确双因子 ⇒ pending');

    const t1 = resolvePairTarget(tdb, pairCode);
    eq(t1.kind, 'ok', 'B5a 带码 ⇒ 唯一定位');
    eq(t1.kind === 'ok' ? t1.pending.id : null, pairingId, 'B5b 定位到的正是这一单');
    eq(resolvePairTarget(tdb, null).kind, 'ok', 'B5c 无码且恰一条 ⇒ 也能定位');

    createPairRequest(tdb, '另一台机器人', '192.168.1.78');
    const t2 = resolvePairTarget(tdb, null);
    eq(t2.kind, 'ambiguous', 'B5d ★两条待批 ⇒ 无码歧义（列候选不猜）');
    eq(t2.kind === 'ambiguous' ? t2.pendings.length : 0, 2, 'B5e 候选恰两条');
    eq(resolvePairTarget(tdb, pairCode).kind, 'ok', 'B5f 带码仍能唯一定位（歧义不误伤）');

    const ap = approveTerminal(tdb, pairingId, [...DEFAULT_TERMINAL_CAPABILITIES]);
    eq(ap, { ok: true }, 'B6a 人批成功');
    const st1 = pairStatus(tdb, pairingId, pairCode);
    eq(st1.status, 'approved', 'B6b 批准后 ⇒ approved');
    ok(st1.status === 'approved' && !!st1.credentials, 'B6c ★首次轮询凭据送达');
    const cred = st1.status === 'approved' ? st1.credentials : undefined;
    if (!cred) throw new Error('凭据未送达');
    ok(!pairStatus(tdb, pairingId, pairCode)?.hasOwnProperty('credentials'),
      'B6d ★凭据只回一次（第二次不再漂在链路上）');

    const hashRow = db.prepare('SELECT secret_hash FROM wa_external_terminals WHERE id = ?').get(pairingId) as { secret_hash?: string };
    ok(hashRow.secret_hash !== cred.secret && /^[0-9a-f]{64}$/.test(hashRow.secret_hash ?? ''),
      'B7 ★库中只存 hash（明文不落库）');

    const v = verifyTerminal(tdb, cred.key, cred.secret, '192.168.1.77');
    eq(v.ok, true, 'B8a 凭据可用');
    eq(v.ok ? v.terminal.capabilities : [], ['intent_control'], 'B8b ★凭据里是最小授权（默认只授意图控制）');

    // 接线：IM 回话那一跳与装配层都指向同一份真实现。
    const imRouter = CODE(`${A}/src/main/services/im-router.ts`);
    ok(/parsePairReply\s*\(/.test(imRouter), 'B9a IM 路由解析「同意接入 <码>」');
    ok(/approveTerminal\s*\(/.test(imRouter), 'B9b IM 路由调用真批准动作');
    ok(/DEFAULT_TERMINAL_CAPABILITIES/.test(imRouter), 'B9c IM 审批传默认词表（不手抄）');
    const mainSrc = CODE(`${A}/src/main/index.ts`);
    ok(/createPairingPort\s*\(/.test(mainSrc), 'B9d 装配层建配对端口');
    ok(mainSrc.includes('buildPairNotice({ name, pairCode: r.pairCode })'), 'B9e ★配对通知推 IM（非阻塞旁挂）');
    ok(/pushImOwnerNotice\s*\(/.test(mainSrc), 'B9f 通知走主人 IM 推送口');
    db.close();
  }

  // ═══ C｜进门之后：看得见被授予的，看不见没给的 ═══════════════════════════
  console.log('\n【C】`GET /capabilities` 脱敏面');
  const nowRef = { at: new Date() };
  let db!: DatabaseSync;
  let probe!: ReturnType<typeof makeProbe>;
  let deps!: InboundDeps;
  let cred!: { key: string; secret: string };
  let terminalId!: string;
  {
    db = makeDoorDb();
    __resetTerminalSecretsForTest();
    const pa = pairAndApprove(db, ['intent_control']);
    cred = pa;
    terminalId = pa.pairingId;
    probe = makeProbe(db);
    const capability: ExternalCapabilityPort = createExternalCapabilityPort(db as never, {
      listDevices: () => DEVICES,
      listRooms: () => ['客厅', '卧室', '客厅', ''],
      controlDevice: probe.control,
      resolveIntentSteps: createHomeIntentResolver(() => DEVICES),
      now: () => nowRef.at,
    });
    deps = {
      nodeName: () => '阳台的工蚁',
      agentVersion: '0.5.0',
      pairing: createPairingPort(db as unknown as TerminalDb),
      capability,
    };

    const res = await handleInboundRequest(
      { method: 'GET', path: INBOUND_CAPABILITIES_PATH, headers: bearer(cred), remoteAddress: '192.168.1.44' }, deps,
    );
    eq(res.status, 200, 'C1 凭据在手 ⇒ `GET /capabilities` 200');
    const body = res.body as {
      terminal_id: string; capabilities: string[]; rooms: string[];
      devices: Array<Record<string, unknown>>;
    };
    eq(body.terminal_id, terminalId, 'C2 自省面只报自己那一行');
    eq(body.capabilities, ['intent_control'], 'C3 ★只列已授予的（不推销没给的）');
    ok(!body.capabilities.includes('device_control'), 'C4 ★反证：未授予的原始动作不出现');
    eq(body.rooms.length, 2, 'C5 房间去重（4 条输入含重复与空串 ⇒ 2 个真房间）');
    ok(body.rooms.includes('客厅') && body.rooms.includes('卧室') && !body.rooms.includes(''),
      'C6 房间名原样、空串不冒充房间');
    eq(body.devices.length, DEVICES.length, 'C7 设备清单每台一行（含 unknown 行，设备侧不隐匿）');
    eq(Object.keys(body.devices[0] ?? {}).sort(), ['actions', 'call_name', 'kind', 'kind_class', 'room'],
      'C8 ★脱敏行**恰好五样**');
    const text = JSON.stringify(body);
    ok(!text.includes('10.20.30.40'), 'C9 ★网络坐标不出门');
    ok(!text.includes('"protocol"'), 'C10 ★协议词不出门');
    ok(!text.includes('"status_json"') && !text.includes('"authorized"'), 'C11 ★状态/授权态不出门');
    ok(body.devices.every((d) => typeof d.call_name === 'string' && (d.call_name as string).length > 0),
      'C12 每行都有叫法（别名优先、回退自述名）');
  }

  // ═══ D｜意图两跳：resolve 零副作用 → execute 只执行一次 ═══════════════════
  console.log('\n【D】`home.comfort`（客厅有点热）');
  {
    const before = probe.calls.length;
    const resolveRes = await handleInboundRequest({
      method: 'POST', path: INBOUND_INTENT_RESOLVE_PATH, headers: bearer(cred), remoteAddress: '192.168.1.44',
      body: { intent: HOME_COMFORT_INTENT, params: { room: '客厅', feeling: 'hot' } },
    }, deps);
    eq(resolveRes.status, 200, 'D1 resolve ⇒ 200');
    const rb = resolveRes.body as {
      planId: string; source: string; steps: Array<{ call_name: string; action: string; args?: Record<string, unknown> }>;
    };
    eq(rb.steps.map((s) => ({ call_name: s.call_name, action: s.action })), [
      { call_name: '客厅窗帘', action: 'close' },
      { call_name: '客厅空调', action: 'set_temperature' },
      { call_name: '客厅风扇', action: 'turn_on' },
    ], 'D2 ★三步次序＝规则表（关窗帘 → 空调 → 风扇）');
    eq(rb.steps[1]?.args, { temperature: 26 }, 'D3 空调设 26℃');
    eq(rb.source, 'rule', 'D4 规则路径（不调模型）');
    eq(probe.calls.length, before, 'D5 ★resolve 零副作用（设备传动 0 次）');
    eq(actionRows(db), 0, 'D6 ★resolve 不写设备动作账（0 行）');
    eq(planRows(db), 1, 'D7 ★0→1：计划账落一行');
    eq(planStatus(db, rb.planId), 'planned', 'D8 计划态＝planned');

    const exe = await handleInboundRequest({
      method: 'POST', path: INBOUND_INTENT_EXECUTE_PATH, headers: bearer(cred), remoteAddress: '192.168.1.44',
      body: { planId: rb.planId },
    }, deps);
    eq(exe.status, 200, 'D9 execute ⇒ 200');
    eq((exe.body as { status?: string }).status, 'executed', 'D10 全步成功 ⇒ executed');
    eq(probe.calls.length - before, 3, 'D11 ★执行三步，传动恰 3 次');
    eq(actionRows(db), 3, 'D12 ★动作账 3 行（行数＝执行步数）');
    eq(planStatus(db, rb.planId), 'executed', 'D13 计划收口 executed');
    eq(probe.calls.slice(-3).map((c) => [c.name, c.action]), [
      ['客厅窗帘', 'close'], ['客厅空调', 'set_temperature'], ['客厅风扇', 'turn_on'],
    ], 'D14 传动收到的设备/动作与计划逐条对齐');
    ok(probe.calls.slice(-3).every((c) => c.terminalId === terminalId && c.planId === rb.planId),
      'D15 ★发起者身份与计划号一路带到传动（可追责）');

    const again = await handleInboundRequest({
      method: 'POST', path: INBOUND_INTENT_EXECUTE_PATH, headers: bearer(cred), remoteAddress: '192.168.1.44',
      body: { planId: rb.planId },
    }, deps);
    eq(again.status, 409, 'D16 ★第二次 execute ⇒ 409（只执行一次）');
    eq((again.body as { error?: string }).error, 'plan_already_executed', 'D17 回因＝plan_already_executed');
    eq(probe.calls.length - before, 3, 'D18 ★不重放（传动仍 3 次）');

    const audit = listExternalCalls(db, 100);
    ok(audit.some((r) => r.capability === 'intent_control' && r.result === 'ok' && Boolean(r.args.planId)),
      'D19 ★resolve 留痕带 planId（可回查"计划从哪来"）');
    ok(audit.some((r) => r.reason === 'plan_already_executed' && r.result === 'denied'),
      'D20 ★重复执行也被拒并留痕');
  }

  // ═══ E｜离家：只走规则；全屋/单房间两侧标本 ═══════════════════════════════
  console.log('\n【E】`home.away`');
  {
    const before = probe.calls.length;
    const away = await handleInboundRequest({
      method: 'POST', path: INBOUND_INTENT_RESOLVE_PATH, headers: bearer(cred), remoteAddress: '192.168.1.44',
      body: { intent: HOME_AWAY_INTENT, params: {} },
    }, deps);
    eq(away.status, 200, 'E1 全屋离家 resolve ⇒ 200');
    const ab = away.body as { source: string; steps: Array<{ call_name: string; action: string }> };
    eq(ab.steps.map((s) => s.call_name), ['客厅灯', '卧室灯', '客厅空调', '客厅风扇', '客厅窗帘'],
      'E2 ★全屋次序＝灯 → 空调 → 风扇 → 窗帘（开关/传感器不猜）');
    eq(ab.steps.map((s) => s.action), ['turn_off', 'turn_off', 'turn_off', 'turn_off', 'close'], 'E3 动作与角色对应');
    eq(ab.source, 'rule', 'E4 离家只走规则');
    eq(probe.calls.length, before, 'E5 ★resolve 仍零副作用');

    const roomAway = await handleInboundRequest({
      method: 'POST', path: INBOUND_INTENT_RESOLVE_PATH, headers: bearer(cred), remoteAddress: '192.168.1.44',
      body: { intent: HOME_AWAY_INTENT, params: { room: '卧室' } },
    }, deps);
    eq(roomAway.status, 200, 'E6 单房间离家 ⇒ 200');
    const bedroomSteps = (roomAway.body as { steps: Array<{ call_name: string; action: string; reason?: string }> }).steps;
    eq(bedroomSteps.map((s) => [s.call_name, s.action]), [['卧室灯', 'turn_off']],
      'E7 ★房间界限精确（只动卧室）');
    ok(bedroomSteps.every((s) => (s.reason ?? '').includes('离家')), 'E8 ★只调房间后的每步都带离家人话');
  }

  // ═══ F｜原始动作：须显式授予；三态各回各因、被拒也留痕 ═══════════════════
  console.log('\n【F】`/invoke` 原始动作闸');
  {
    const db2 = makeDoorDb();
    __resetTerminalSecretsForTest();
    const cred2 = pairAndApprove(db2, ['intent_control']);
    const probe2 = makeProbe(db2);
    const capability2 = createExternalCapabilityPort(db2 as never, {
      listDevices: () => DEVICES,
      controlDevice: probe2.control,
      resolveIntentSteps: createHomeIntentResolver(() => DEVICES),
      now: () => nowRef.at,
    });
    const deps2: InboundDeps = {
      nodeName: () => '阳台的工蚁', agentVersion: '0.5.0',
      pairing: createPairingPort(db2 as unknown as TerminalDb),
      capability: capability2,
    };

    const denyNotGranted = await handleInboundRequest({
      method: 'POST', path: INBOUND_INVOKE_PATH, headers: bearer(cred2), remoteAddress: '192.168.1.44',
      body: { capability: 'device_control', args: { name: '客厅灯', action: 'turn_on' } },
    }, deps2);
    eq(denyNotGranted.status, 403, 'F1a 未授予 `device_control` ⇒ 403');
    eq((denyNotGranted.body as { error?: string }).error, 'capability_not_granted', 'F1b 回因＝capability_not_granted');
    eq(probe2.calls.length, 0, 'F1c ★反证：未授予则一次传动都不触');

    const denyInvokeIntent = await handleInboundRequest({
      method: 'POST', path: INBOUND_INVOKE_PATH, headers: bearer(cred2), remoteAddress: '192.168.1.44',
      body: { capability: 'intent_control', args: {} },
    }, deps2);
    eq(denyInvokeIntent.status, 403, 'F2a 意图控制不可经 `/invoke` 直调');
    eq((denyInvokeIntent.body as { error?: string }).error, 'capability_not_invocable', 'F2b 回因＝capability_not_invocable');
    eq(probe2.calls.length, 0, 'F2c 仍 0 次传动');

    const badRequest = await handleInboundRequest({
      method: 'POST', path: INBOUND_INVOKE_PATH, headers: bearer(cred2), remoteAddress: '192.168.1.44',
      body: { args: {} },
    }, deps2);
    eq(badRequest.status, 400, 'F3a 缺 capability ⇒ 400');
    eq((badRequest.body as { error?: string }).error, 'capability_required', 'F3b 回因＝capability_required');
    eq(listExternalCalls(db2, 100).length, 2, 'F3c ★烂请求不落账（仍 2 行：两次被拒各一行）');

    // 显式授予后放行（正标本）。
    __resetTerminalSecretsForTest();
    const cred3 = pairAndApprove(db2, ['device_control']);
    const allow = await handleInboundRequest({
      method: 'POST', path: INBOUND_INVOKE_PATH, headers: bearer(cred3), remoteAddress: '192.168.1.44',
      body: { capability: 'device_control', args: { name: '客厅灯', action: 'turn_on' } },
    }, deps2);
    eq(allow.status, 200, 'F4a ★正标本：显式授予后 `/invoke` ⇒ 200');
    eq((allow.body as { ok?: boolean }).ok, true, 'F4b 执行成功');
    eq(probe2.calls.length, 1, 'F4c 传动恰 1 次');
    eq(actionRows(db2), 1, 'F4d 动作账 1 行');

    const rows = listExternalCalls(db2, 100);
    ok(rows.some((r) => r.result === 'ok' && r.capability === 'device_control' && r.remote_addr === '192.168.1.44'),
      'F5a ★成功留痕（含来路地址）');
    ok(rows.some((r) => r.result === 'denied' && r.reason === 'capability_not_granted'),
      'F5b ★被拒留痕：未授予');
    ok(rows.some((r) => r.result === 'denied' && r.reason === 'capability_not_invocable'),
      'F5c ★被拒留痕：不可直调');
    ok(rows.every((r) => r.terminal_id.length > 0), 'F5d 每条留痕都有发起者身份');
    db2.close();
  }

  db.close();
}

main().then(() => {
  console.log(`\n[rr_zx_20261107_1_terminal] ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
