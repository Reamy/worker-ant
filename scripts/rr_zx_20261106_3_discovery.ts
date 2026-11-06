/**
 * zx_20261106_3「协」B7 受控回归 —— 通用 AI 终端发现（A2A 门牌）与双模协商。
 *
 * A 门牌解析：标准卡字段收敛；缺 name 即"不是卡片"；意图/技能/能力面皆有上限。
 * B 目标解析：只认私网；拒绝非 http/https、拒绝带账号密码；域名留 DNS 后判；完整卡地址优先。
 * C 双模协商：未声明意图 ⇒ invoke；声明 + 授予意图控制 ⇒ intent；声明但未授予 ⇒ invoke。
 * D 发现编排（假 IO）：两跳依次试；两跳皆败如实汇总；IO 抛错不吞；成功只进内存待接入。
 * E 真 IO 有界（127.0.0.1 本机桩）：200 取卡；404 回退；3xx 拒绝跟随；超体积断开；超时如实。
 * F 配对往返（真 DB）：来路 discovery + 门牌意图落库；协商读时现算；凭据只回一次且只存 hash；
 *   老夹具缺列时降级为"未声明意图/remote"而不拦配对。
 * G 待接入列表：10 分钟 TTL、取走即移、过期即清。
 * H mDNS `_a2a._tcp` 有界扫描：只取私网、静默过滤、去重、上限 8、错误如实。
 * I 静态接线：五个 IPC 全在 Team 闸后；发现≠授权；枚举新值穷举全部读取谓词。
 *
 * 纪律：外部网络零触达（E 组只连 127.0.0.1 本机桩）；零 electron；断言文案不含失败字形；
 *   now 注入、TTL 判据不靠墙钟；夹具照生产 DDL，先建表后插行。
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';

import {
  AGENT_CARD_PROBE_PATHS,
  A2A_MDNS_SERVICE,
  A2A_SCAN_MAX_TARGETS,
  DISCOVERY_PENDING_TTL_MS,
  __resetDiscoveredForTest,
  a2aAnnouncementTarget,
  defaultAgentDiscoveryIo,
  discoverAgent,
  discoveredAgentId,
  forgetDiscovered,
  listDiscovered,
  parseAgentCard,
  parseProbeTarget,
  scanA2ADiscovery,
  takeDiscovered,
  type A2ABrowseIo,
  type AgentCardProbe,
  type AgentDiscoveryIo,
} from '../apps/worker-ant-desktop/src/main/core/agent-discovery.js';
import {
  MAX_DECLARED_INTENTS,
  negotiateTerminalMode,
  sanitizeDeclaredIntents,
} from '../apps/worker-ant-desktop/src/main/core/terminal-negotiation.js';
import {
  __resetTerminalSecretsForTest,
  approveTerminal,
  buildPairNotice,
  createPairRequest,
  createPairRequestGuarded,
  getTerminalBrief,
  hashTerminalSecret,
  listTerminals,
  pairStatus,
  type TerminalDb,
} from '../apps/worker-ant-desktop/src/main/core/external-terminals.js';
import { formatTerminalCandidate } from '../apps/worker-ant-desktop/src/main/core/im/approval-inbox.js';
import {
  INBOUND_AGENT_CARD_PATH,
  INBOUND_WELL_KNOWN_PATH,
  isPrivateAddress,
} from '../apps/worker-ant-desktop/src/main/core/inbound-gate.js';
import { INTENT_CAPABILITY } from '../apps/worker-ant-desktop/src/main/core/intent-protocol.js';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  PASS ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (actual: unknown, expect: unknown, label: string) =>
  ok(JSON.stringify(actual) === JSON.stringify(expect), label, `${JSON.stringify(actual)} vs ${JSON.stringify(expect)}`);

const root = path.join(__dirname, '..');
const A = 'apps/worker-ant-desktop';
const RD = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf-8');
const CODE = (rel: string) => stripKeepingLines(RD(rel)).join('\n');
const countOcc = (hay: string, needle: string): number => hay.split(needle).length - 1;

const NOW = Date.parse('2026-11-06T00:00:00.000Z');
const at = (ms: number) => () => NOW + ms;

/** 假 IO：按 URL 回固定结果，同时记下被探测的地址（用于断言两跳顺序与"未触网"）。 */
function fakeIo(handler: (url: URL) => AgentCardProbe | Promise<AgentCardProbe>): AgentDiscoveryIo & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async probe(url) {
      calls.push(url.pathname);
      return handler(url);
    },
  };
}
const cardProbe = (name: string): AgentCardProbe => ({
  ok: true,
  card: { name, description: '', version: null, protocol: null, intents: [], skills: [], features: [] },
  cardUrl: null,
  status: 200,
  reason: '',
  bodyBytes: 2,
});
const missProbe = (reason: string): AgentCardProbe => ({
  ok: false, card: null, cardUrl: null, status: 404, reason, bodyBytes: 0,
});

/* ── A｜门牌解析 ──────────────────────────────────────────────────────────── */

function sectionA(): void {
  console.log('\n【A】门牌解析：字段收敛 · 缺名即非卡 · 三面上限');
  eq([...AGENT_CARD_PROBE_PATHS], [INBOUND_AGENT_CARD_PATH, INBOUND_WELL_KNOWN_PATH],
    'A-1 两条探测路径与入站门同源（不是第二套门牌）');

  const card = parseAgentCard({
    name: '  客厅助手  ',
    description: '控制客厅设备',
    version: '1.2.0',
    protocolVersion: '0.2.1',
    intents: ['room_too_hot', 'room_too_hot', ' turn_on_light '],
    skills: [{ id: 'light', name: '灯' }, 'curtain', { name: '空调' }, {}],
    capabilities: { streaming: true, push: false, label: 'x' },
  });
  ok(card !== null, 'A-2 标准卡可识别');
  eq(card?.name, '客厅助手', 'A-3 名字去空白');
  eq(card?.description, '控制客厅设备', 'A-4 描述保留');
  eq(card?.version, '1.2.0', 'A-5 版本保留');
  eq(card?.protocol, '0.2.1', 'A-6 协议取 protocolVersion');
  eq(card?.intents, ['room_too_hot', 'turn_on_light'], 'A-7 意图去重、去空白、保序');
  eq(card?.skills, [{ id: 'light', name: '灯' }, { id: 'curtain', name: 'curtain' }, { id: '空调', name: '空调' }],
    'A-8 技能支持对象/字符串，空条目丢弃');
  eq(card?.features, ['streaming'], 'A-9 能力面只收 true 键');

  eq(parseAgentCard({ description: '无名字' }), null, 'A-10 缺 name 即 null（不猜它是谁）');
  eq(parseAgentCard([]), null, 'A-11 数组不是卡片');
  eq(parseAgentCard(null), null, 'A-12 null 不是卡片');

  const many = parseAgentCard({
    name: 'x',
    intents: Array.from({ length: 24 }, (_, i) => `i${i}`),
    skills: Array.from({ length: 40 }, (_, i) => `s${i}`),
  });
  eq(many?.intents.length, MAX_DECLARED_INTENTS, 'A-13 意图条数有上限');
  eq(many?.skills.length, 32, 'A-14 技能条数有上限');

  const longIntent = parseAgentCard({ name: 'x', intents: ['y'.repeat(120)] });
  eq(longIntent?.intents[0]?.length, 64, 'A-15 单条意图截断到 64 字符');
}

/* ── B｜目标解析 ──────────────────────────────────────────────────────────── */

function sectionB(): void {
  console.log('\n【B】目标解析：仅私网 · 无凭据 · 域名留 DNS · 完整卡地址优先');
  const t1 = parseProbeTarget('192.168.1.20:8080');
  ok(t1.ok, 'B-1 私网字面地址可解析');
  if (t1.ok) {
    eq(t1.address, '192.168.1.20', 'B-2 主机名归一');
    eq(t1.port, 8080, 'B-3 端口保留');
    eq(t1.endpoint, 'http://192.168.1.20:8080', 'B-4 endpoint 为 origin');
    eq(t1.needsDns, false, 'B-5 字面 IP 不需 DNS 复核');
    eq(t1.candidates.map((u) => new URL(u).pathname), [INBOUND_AGENT_CARD_PATH, INBOUND_WELL_KNOWN_PATH],
      'B-6 两跳顺序：agent-card → agent.json');
  }

  const pub = parseProbeTarget('8.8.8.8');
  ok(!pub.ok && pub.reason.includes('私网'), 'B-7 公网字面地址当场拒');
  const ftp = parseProbeTarget('ftp://192.168.1.2');
  ok(!ftp.ok && ftp.reason.includes('http'), 'B-8 非 http/https 拒');
  const cred = parseProbeTarget('http://user:pass@192.168.1.2');
  ok(!cred.ok && cred.reason.includes('账号密码'), 'B-9 地址不得携带凭据');
  eq(parseProbeTarget(''), { ok: false, reason: '请填写终端地址（例如 192.168.1.20:8080）。' }, 'B-10 空地址如实提示');

  const lan = parseProbeTarget('kitchen.local:3000');
  ok(lan.ok && lan.needsDns === true, 'B-11 域名留给真 IO 在 DNS 解析后复核私网');
  const lo = parseProbeTarget('localhost:8080');
  ok(lo.ok && lo.needsDns === false, 'B-12 localhost 不查 DNS（本机）');

  const full = parseProbeTarget(`http://192.168.1.9:7000${INBOUND_WELL_KNOWN_PATH}`);
  ok(full.ok, 'B-13 用户直接给完整卡地址可解析');
  if (full.ok) eq(full.candidates[0], `http://192.168.1.9:7000${INBOUND_WELL_KNOWN_PATH}`,
    'B-14 用户给的卡地址先试（换过实现的终端两形都有）');
}

/* ── C｜双模协商 ──────────────────────────────────────────────────────────── */

function sectionC(): void {
  console.log('\n【C】双模协商：意图优先 · 指令兜底 · 未授予不假称');
  eq(INTENT_CAPABILITY, 'intent_control', 'C-0 意图能力 id 取自协议真源');

  const none = negotiateTerminalMode({ cardIntents: null, grantedCapabilities: [INTENT_CAPABILITY] });
  eq(none.mode, 'invoke', 'C-1 门牌未声明意图 ⇒ invoke');
  ok(none.reason.includes('未声明意图'), 'C-2 未声明意图的理由可读');
  eq(none.declaredIntents, [], 'C-3 未声明时意图清单为空');

  const intent = negotiateTerminalMode({ cardIntents: ['room_too_hot'], grantedCapabilities: [INTENT_CAPABILITY] });
  eq(intent.mode, 'intent', 'C-4 声明意图且授予意图控制 ⇒ intent');
  ok(intent.reason.includes('意图优先'), 'C-5 意图优先的理由可读');

  const fallback = negotiateTerminalMode({ cardIntents: ['room_too_hot'], grantedCapabilities: ['device_control'] });
  eq(fallback.mode, 'invoke', 'C-6 声明意图但未授予意图控制 ⇒ invoke（不假称能走）');
  ok(fallback.reason.includes('未授予'), 'C-7 兜底理由可读');

  const empty = negotiateTerminalMode({ cardIntents: ['', '   ', 42, null] });
  eq(empty.mode, 'invoke', 'C-8 非法意图条目不构成声明');

  eq(sanitizeDeclaredIntents(['a', 'a', ' a ', 'b']), ['a', 'b'], 'C-9 意图去重、去空白、保序');
  eq(sanitizeDeclaredIntents(Array.from({ length: 30 }, (_, i) => `x${i}`)).length, MAX_DECLARED_INTENTS,
    'C-10 条数上限与门牌解析同源');
  eq(sanitizeDeclaredIntents('not-an-array'), [], 'C-11 非数组一律空（不猜）');
}

/* ── D｜发现编排（假 IO） ─────────────────────────────────────────────────── */

async function sectionD(): Promise<void> {
  console.log('\n【D】发现编排：两跳顺序 · 失败如实 · 只进内存');
  __resetDiscoveredForTest();

  const io1 = fakeIo((u) => (u.pathname === INBOUND_WELL_KNOWN_PATH ? cardProbe('厨房助手') : missProbe('无卡片')));
  const r1 = await discoverAgent('192.168.1.30:8080', { io: io1, now: at(0) });
  ok(r1.ok, 'D-1 第一跳失败、第二跳成功仍算发现');
  if (r1.ok) {
    eq(new URL(r1.agent.cardUrl).pathname, INBOUND_WELL_KNOWN_PATH, 'D-2 命中的是第二跳（如实可查）');
    eq(r1.agent.source, 'manual', 'D-3 手工探测来路为 manual');
    eq(r1.agent.endpoint, 'http://192.168.1.30:8080', 'D-4 endpoint 稳定形态');
  }
  eq(io1.calls, [INBOUND_AGENT_CARD_PATH, INBOUND_WELL_KNOWN_PATH], 'D-5 两跳按约定顺序依次试');

  const io2 = fakeIo(() => missProbe('未取到卡片'));
  const r2 = await discoverAgent('192.168.1.31:8080', { io: io2, now: at(0) });
  ok(!r2.ok, 'D-6 两跳皆败 ⇒ 发现失败');
  if (!r2.ok) {
    eq(r2.attempts.length, 2, 'D-7 两条尝试都如实记录');
    ok(r2.reason.includes(INBOUND_AGENT_CARD_PATH) && r2.reason.includes(INBOUND_WELL_KNOWN_PATH),
      'D-8 失败理由列出两跳');
  }

  const io3 = fakeIo(() => { throw new Error('连接被拒'); });
  const r3 = await discoverAgent('192.168.1.32:8080', { io: io3, now: at(0) });
  ok(!r3.ok && r3.attempts.every((a) => a.reason.includes('连接被拒')), 'D-9 IO 抛错被收敛成尝试记录，不中断');

  const io4 = fakeIo(() => cardProbe('客厅助手'));
  const bad = await discoverAgent('8.8.8.8', { io: io4, now: at(0) });
  ok(!bad.ok && io4.calls.length === 0, 'D-10 公网地址在解析处即拒，不发请求');

  const list = listDiscovered(NOW);
  ok(list.length === 1, 'D-11 只有成功的发现进待接入列表');
  eq(list[0]?.name, '厨房助手', 'D-12 列表项名如实');
  eq(list[0]?.id, discoveredAgentId('厨房助手', 'http://192.168.1.30:8080'),
    'D-13 发现 id 由 名字+endpoint 派生（稳定可复算）');

  const io5 = fakeIo(() => cardProbe('厨房助手'));
  const again = await discoverAgent('192.168.1.30:8080', { io: io5, now: at(120_000) });
  ok(again.ok, 'D-14 再次发现同一台成功');
  const againItem = listDiscovered(NOW + 120_000).find((x) => x.name === '厨房助手');
  eq(againItem?.firstSeenMs, NOW, 'D-15 再次见到保留首次时间（不是每次重置）');
  eq(againItem?.lastSeenMs, NOW + 120_000, 'D-16 最近见到随之推进');

  const mdns = await discoverAgent('192.168.1.33', { io: fakeIo(() => cardProbe('卧室助手')), now: at(0), source: 'mdns' });
  ok(mdns.ok && mdns.agent.source === 'mdns', 'D-17 mDNS 来路如实标注');
  __resetDiscoveredForTest();
}

/* ── E｜真 IO 有界（本机桩） ──────────────────────────────────────────────── */

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return (server.address() as { port: number }).port;
}
async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((r) => {
    server.closeAllConnections?.();
    server.close(() => r());
  });
}

async function sectionE(): Promise<void> {
  console.log('\n【E】真 IO 有界：200 取卡 · 404 回退 · 3xx 拒绝跟随 · 体积/超时如实');
  const io = defaultAgentDiscoveryIo();

  // E-1 200 取卡
  {
    const srv = http.createServer((req, res) => {
      if (req.url === INBOUND_AGENT_CARD_PATH) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ name: '客厅助手', description: '控制客厅', version: '1.0.0', intents: ['room_too_hot'] }));
        return;
      }
      res.writeHead(404); res.end();
    });
    const port = await listen(srv);
    try {
      const r = await io.probe(new URL(`http://127.0.0.1:${port}${INBOUND_AGENT_CARD_PATH}`),
        { timeoutMs: 2000, maxBytes: 65536 });
      ok(r.ok && r.card?.name === '客厅助手', 'E-1 200 响应解析成卡片');
      eq(r.card?.intents, ['room_too_hot'], 'E-2 卡片意图原样带回');
    } finally { await closeServer(srv); }
  }

  // E-3 第一跳 404、第二跳 200（走真 discoverAgent 两跳）
  {
    __resetDiscoveredForTest();
    const srv = http.createServer((req, res) => {
      if (req.url === INBOUND_WELL_KNOWN_PATH) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ name: '回退助手' }));
        return;
      }
      res.writeHead(404); res.end();
    });
    const port = await listen(srv);
    try {
      const r = await discoverAgent(`127.0.0.1:${port}`, { io, now: at(0) });
      ok(r.ok && r.agent.name === '回退助手', 'E-3 第一跳 404 时回退第二跳（真网络路径）');
      if (r.ok) eq(new URL(r.agent.cardUrl).pathname, INBOUND_WELL_KNOWN_PATH, 'E-4 落定的是真正命中的那一跳');
    } finally { await closeServer(srv); __resetDiscoveredForTest(); }
  }

  // E-5 3xx 拒绝跟随（目标服务器一次都不该被访问）
  {
    let targetHits = 0;
    const target = http.createServer((_req, res) => { targetHits++; res.writeHead(200); res.end('{}'); });
    const targetPort = await listen(target);
    const redirect = http.createServer((_req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${targetPort}${INBOUND_AGENT_CARD_PATH}` });
      res.end();
    });
    const redirectPort = await listen(redirect);
    try {
      const r = await io.probe(new URL(`http://127.0.0.1:${redirectPort}${INBOUND_AGENT_CARD_PATH}`),
        { timeoutMs: 2000, maxBytes: 65536 });
      ok(!r.ok && r.reason.includes('重定向'), 'E-5 3xx 如实拒绝');
      eq(targetHits, 0, 'E-6 未跟随重定向（目标一次都没被访问）');
    } finally { await closeServer(redirect); await closeServer(target); }
  }

  // E-7 响应体超上限即断
  {
    const srv = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ name: 'big', padding: 'x'.repeat(4096) }));
    });
    const port = await listen(srv);
    try {
      const r = await io.probe(new URL(`http://127.0.0.1:${port}${INBOUND_AGENT_CARD_PATH}`),
        { timeoutMs: 2000, maxBytes: 1024 });
      ok(!r.ok && r.reason.includes('超过上限'), 'E-7 超过体积上限即断开并如实报');
      ok(r.bodyBytes > 1024, 'E-8 已收字节数与实际读取一致（不是假装 0）');
    } finally { await closeServer(srv); }
  }

  // E-9 超时如实（对端迟迟不响应）
  {
    const srv = http.createServer(() => { /* 故意不响应 */ });
    const port = await listen(srv);
    try {
      const r = await io.probe(new URL(`http://127.0.0.1:${port}${INBOUND_AGENT_CARD_PATH}`),
        { timeoutMs: 150, maxBytes: 65536 });
      ok(!r.ok && r.reason.includes('探测超时'), 'E-9 超时如实报（不无限等）');
    } finally { await closeServer(srv); }
  }

  // E-10 非 JSON 如实报
  {
    const srv = http.createServer((_req, res) => { res.writeHead(200); res.end('not json'); });
    const port = await listen(srv);
    try {
      const r = await io.probe(new URL(`http://127.0.0.1:${port}${INBOUND_AGENT_CARD_PATH}`),
        { timeoutMs: 2000, maxBytes: 65536 });
      ok(!r.ok && r.reason.includes('JSON'), 'E-10 非 JSON 如实报');
    } finally { await closeServer(srv); }
  }
}

/* ── F｜配对往返（真 DB） ─────────────────────────────────────────────────── */

const SCHEMA = `
CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_external_terminals (
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
  source TEXT DEFAULT 'remote',
  card_intents_json TEXT DEFAULT ''
)`;
const OLD_SCHEMA = `
CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_external_terminals (
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
  grant_expires_at TEXT
)`;

function sectionF(): void {
  console.log('\n【F】配对往返：来路落库 · 协商现算 · 凭据只回一次且只存 hash');
  __resetTerminalSecretsForTest();
  const d = new DatabaseSync(':memory:');
  d.exec(SCHEMA);
  const tdb = d as unknown as TerminalDb;

  const r = createPairRequestGuarded(tdb, '客厅助手', '192.168.1.40', {
    source: 'discovery',
    cardIntents: ['room_too_hot', 'turn_on_light'],
  });
  ok(r.ok, 'F-1 带发现来路的配对申请成立');
  if (!r.ok) return;

  const row = d.prepare('SELECT * FROM wa_external_terminals WHERE id = ?').get(r.pairingId) as Record<string, unknown>;
  eq(row.source, 'discovery', 'F-2 来路 discovery 落库');
  eq(JSON.parse(String(row.card_intents_json)), ['room_too_hot', 'turn_on_light'], 'F-3 门牌意图随申请落库');

  const pending = listTerminals(tdb).find((t) => t.id === r.pairingId);
  eq(pending?.source, 'discovery', 'F-4 读口归还 discovery 来路');
  eq(pending?.negotiation.mode, 'invoke', 'F-5 尚未授予能力时协商为 invoke');
  eq(pending?.negotiation.declaredIntents, ['room_too_hot', 'turn_on_light'], 'F-6 声明的意图仍如实可见');

  const ap = approveTerminal(tdb, r.pairingId, [INTENT_CAPABILITY]);
  ok(ap.ok, 'F-7 批准成功');
  const approved = listTerminals(tdb).find((t) => t.id === r.pairingId);
  eq(approved?.negotiation.mode, 'intent', 'F-8 ★0→1：授予意图控制后协商切到 intent（读时现算）');

  const first = pairStatus(tdb, r.pairingId, r.pairCode);
  ok(first.status === 'approved' && !!first.credentials, 'F-9 首次取凭据成功');
  const secret = first.status === 'approved' ? first.credentials?.secret : undefined;
  ok(!!secret, 'F-10 拿到凭据 secret');
  const second = pairStatus(tdb, r.pairingId, r.pairCode);
  ok(second.status === 'approved' && !second.credentials, 'F-11 凭据只回一次（第二次不再回）');

  const after = d.prepare('SELECT * FROM wa_external_terminals WHERE id = ?').get(r.pairingId) as Record<string, unknown>;
  eq(after.secret_hash, hashTerminalSecret(String(secret)), 'F-12 库里只存 secret 的 sha256');
  ok(String(after.secret_hash).length === 64, 'F-13 哈希形如 64 位 hex');
  ok(!JSON.stringify(after).includes(String(secret)), 'F-14 行内没有任何明文凭据');

  const brief = getTerminalBrief(tdb, r.pairingId);
  eq(brief?.source, 'discovery', 'F-15 终端摘要如实带 discovery 来路');

  ok(buildPairNotice({ name: '客厅助手', pairCode: '123456', source: 'discovery' }).includes('A2A 地址发现'),
    'F-16 配对通知说清来路（A2A 地址发现）');
  ok(buildPairNotice({ name: '客厅助手', pairCode: '123456', source: 'lan' }).includes('局域网发现'),
    'F-17 局域网来路仍是局域网（不混称）');
  ok(!buildPairNotice({ name: '客厅助手', pairCode: '123456' }).includes('发现'),
    'F-18 终端自己敲门不加来路标签');

  d.close();

  // F-19 老夹具缺 source/card_intents_json 列：降级但不拦配对。
  const old = new DatabaseSync(':memory:');
  old.exec(OLD_SCHEMA);
  const oldDb = old as unknown as TerminalDb;
  const r2 = createPairRequestGuarded(oldDb, '老库助手', '192.168.1.41', {
    source: 'discovery',
    cardIntents: ['room_too_hot'],
  });
  ok(r2.ok, 'F-19 老库缺列时配对照常成立');
  if (r2.ok) {
    const pub = listTerminals(oldDb).find((t) => t.id === r2.pairingId);
    eq(pub?.source, 'remote', 'F-20 缺列时来路兜底 remote（不编造）');
    eq(pub?.negotiation.mode, 'invoke', 'F-21 缺列时按未声明意图兜底 invoke');
  }
  old.close();

  // F-22 授权收件箱一行：来路 discovery 如实上屏。
  const fake = {
    id: 't1', name: '客厅助手', source: 'discovery', last_remote_addr: '192.168.1.40', pair_code: '123456',
  } as unknown as Parameters<typeof formatTerminalCandidate>[0];
  ok(formatTerminalCandidate(fake).includes('A2A 地址发现'), 'F-22 授权台一行带 A2A 地址发现');
  ok(formatTerminalCandidate(fake).includes('核对码 123456'), 'F-23 核对码原样上屏');
}

/* ── G｜待接入列表 TTL ───────────────────────────────────────────────────── */

async function sectionG(): Promise<void> {
  console.log('\n【G】待接入列表：10 分钟 TTL · 取走即移 · 过期即清');
  __resetDiscoveredForTest();
  await discoverAgent('192.168.1.50', { io: fakeIo(() => cardProbe('取走助手')), now: at(0) });
  const item = listDiscovered(NOW).find((x) => x.name === '取走助手');
  ok(!!item, 'G-1 刚发现的项在列表里');

  if (item) {
    eq(takeDiscovered(item.id, NOW + 1000)?.name, '取走助手', 'G-2 取走时可拿到该项');
    eq(takeDiscovered(item.id, NOW + 1000), null, 'G-3 取走即移（第二次为空）');
  }

  await discoverAgent('192.168.1.51', { io: fakeIo(() => cardProbe('TTL 助手')), now: at(0) });
  ok(listDiscovered(NOW + DISCOVERY_PENDING_TTL_MS - 1000).some((x) => x.name === 'TTL 助手'),
    'G-4 未到 10 分钟仍在列表');
  ok(!listDiscovered(NOW + DISCOVERY_PENDING_TTL_MS + 1000).some((x) => x.name === 'TTL 助手'),
    'G-5 超过 10 分钟即散（发现是"此刻谁在"，不是账本）');

  await discoverAgent('192.168.1.52', { io: fakeIo(() => cardProbe('过期助手')), now: at(0) });
  const stale = listDiscovered(NOW).find((x) => x.name === '过期助手');
  if (stale) {
    eq(takeDiscovered(stale.id, NOW + DISCOVERY_PENDING_TTL_MS + 1), null, 'G-6 过期项取走返回空');
    ok(!listDiscovered(NOW).some((x) => x.name === '过期助手'), 'G-7 过期项同时被清除');
  } else {
    ok(false, 'G-6 夹具项缺失');
  }

  await discoverAgent('192.168.1.52', { io: fakeIo(() => cardProbe('忘掉我')), now: at(0) });
  const f = listDiscovered(NOW).find((x) => x.name === '忘掉我');
  if (f) forgetDiscovered(f.id);
  ok(!listDiscovered(NOW).some((x) => x.name === '忘掉我'), 'G-8 显式丢弃即移出列表');
  __resetDiscoveredForTest();
}

/* ── H｜mDNS 有界扫描 ───────────────────────────────────────────────────── */

function sectionH(): void {
  console.log('\n【H】mDNS `_a2a._tcp` 扫描：仅私网 · 静默过滤 · 去重 · 上限 8');
  eq(A2A_MDNS_SERVICE, 'a2a', 'H-0 浏览的是标准 `_a2a._tcp`，不是自家服务名');

  eq(a2aAnnouncementTarget({ addresses: ['8.8.8.8', '192.168.1.60'], port: 80, name: 'x' }),
    { name: 'x', address: '192.168.1.60', port: 80 }, 'H-1 多地址中只取私网');
  eq(a2aAnnouncementTarget({ addresses: ['8.8.8.8'], host: '1.1.1.1', name: 'x' }), null,
    'H-2 全是公网地址 ⇒ 不探测');
  eq(a2aAnnouncementTarget({ referer: { address: '10.0.0.9' }, port: 8080, name: 'x' }),
    { name: 'x', address: '10.0.0.9', port: 8080 }, 'H-3 referer 地址可用');
  eq(a2aAnnouncementTarget({ host: '192.168.1.61', txt: { name: '门牌名' }, name: '广播名' })?.name, '门牌名',
    'H-4 txt.name 优先于广播名');
  eq(a2aAnnouncementTarget({ host: '192.168.1.61' })?.name, '192.168.1.61', 'H-5 无名字时用地址（不编名字）');
}

async function sectionHScan(): Promise<void> {
  // H-6 扫描：2 私网（1 静默）+ 1 公网；只探 1 台。
  __resetDiscoveredForTest();
  const io = fakeIo((u) => cardProbe(`扫描-${u.hostname}`));
  let stopped = 0;
  const browseIo: A2ABrowseIo = {
    start(onFound) {
      onFound({ addresses: ['192.168.1.70'], port: 7001, txt: { name: '窗边助手' } });
      onFound({ addresses: ['192.168.1.71'], port: 7002, txt: { name: '静默助手' } });
      onFound({ addresses: ['8.8.8.8'], port: 7003, txt: { name: '公网家伙' } });
      onFound({ addresses: ['192.168.1.70'], port: 7001, txt: { name: '窗边助手' } });
    },
    stop() { stopped++; },
  };
  const res = await scanA2ADiscovery({
    browseIo,
    io,
    now: at(0),
    scanMs: 1,
    isSilenced: (t) => t.name === '静默助手',
  });
  eq(res.targets, 1, 'H-6 静默项与公网项都不成目标，重复广播去重');
  eq(res.agents.length, 1, 'H-7 只得到一台可接入终端');
  eq(res.agents[0]?.name, '扫描-192.168.1.70', 'H-8 探测结果名来自门牌（不是广播名）');
  eq(res.agents[0]?.source, 'mdns', 'H-9 扫描来路标 mdns');
  ok(stopped === 1, 'H-10 扫描结束即停浏览');

  // H-11 上限：10 个私网目标只探 8 个。
  __resetDiscoveredForTest();
  const io2 = fakeIo((u) => cardProbe(`上限-${u.port}`));
  const many: A2ABrowseIo = {
    start(onFound) {
      for (let i = 0; i < 10; i++) onFound({ addresses: [`192.168.2.${10 + i}`], port: 8000 + i, txt: { name: `n${i}` } });
    },
    stop() { /* noop */ },
  };
  const res2 = await scanA2ADiscovery({ browseIo: many, io: io2, now: at(0), scanMs: 1 });
  eq(res2.targets, A2A_SCAN_MAX_TARGETS, 'H-11 目标数封顶 8（不把广播变成请求风暴）');
  ok(io2.calls.length <= A2A_SCAN_MAX_TARGETS, 'H-12 实际探测次数不超过上限');

  // H-13 浏览起不来：错误如实带出，不抛。
  __resetDiscoveredForTest();
  const broken: A2ABrowseIo = {
    start() { throw new Error('mDNS 不可用'); },
    stop() { /* noop */ },
  };
  const res3 = await scanA2ADiscovery({ browseIo: broken, io: fakeIo(() => cardProbe('x')), now: at(0), scanMs: 1 });
  ok(res3.error === 'mDNS 不可用' && res3.targets === 0, 'H-13 浏览起不来如实报错且零目标');
  __resetDiscoveredForTest();
}

/* ── I｜静态接线 ─────────────────────────────────────────────────────────── */

function handlerBody(src: string, name: string): string {
  const start = src.indexOf(`ipcMain.handle('${name}'`);
  if (start < 0) return '';
  const next = src.indexOf('ipcMain.handle(', start + 10);
  return src.slice(start, next < 0 ? undefined : next);
}

function sectionI(): void {
  console.log('\n【I】静态接线：五 IPC 在 Team 闸后 · 发现≠授权 · 新枚举值穷举读取谓词');
  const IPC = CODE(`${A}/src/main/ipc/external.ipc.ts`);
  for (const h of ['external:agentList', 'external:agentProbe', 'external:agentScan', 'external:agentRequest', 'external:agentIgnore']) {
    eq(countOcc(IPC, `ipcMain.handle('${h}'`), 1, `I-1 处理器 ${h} 恰一处`);
  }

  const listBody = handlerBody(IPC, 'external:agentList');
  ok(listBody.includes("teamFeatureRefusal(licDb, 'external_terminal')") && listBody.includes('locked ? []'),
    'I-2 agentList 未解锁时如实锁住（不展示发现结果）');
  for (const h of ['external:agentProbe', 'external:agentScan', 'external:agentRequest', 'external:agentIgnore']) {
    const b = handlerBody(IPC, h);
    ok(b.includes("teamFeatureRefusal(licDb, 'external_terminal')") && b.includes("requiredTier: 'team'"),
      `I-3 ${h} 在 Team 闸后（未解锁即拒）`);
  }

  const reqBody = handlerBody(IPC, 'external:agentRequest');
  ok(reqBody.includes("source: 'discovery'"), 'I-4 接入申请记来路 discovery');
  ok(reqBody.includes('cardIntents: item.card.intents'), 'I-5 门牌意图随申请落库（协商数据源）');
  ok(reqBody.includes('negotiateTerminalMode('), 'I-6 接入时算出协商结论并回给界面');
  ok(reqBody.includes('buildPairNotice(') && reqBody.includes("source: 'discovery'"),
    'I-7 配对通知与终端自己敲门同一路（带 A2A 来路）');
  ok(reqBody.includes('createPairRequestGuarded(tdb'), 'I-8 接入复用既有配对账（不另造一套）');
  ok(reqBody.includes('takeDiscovered'), 'I-9 接入后从待接入列表移出');
  ok(!reqBody.includes('approveTerminal('), 'I-10 发现≠授权：接入只建申请，不自动批准');

  const ignoreBody = handlerBody(IPC, 'external:agentIgnore');
  ok(ignoreBody.includes('silenceLanTerminal(sdb') && ignoreBody.includes('takeDiscovered'),
    'I-11 忽略 = 24h 静默 + 移出列表');

  const scanBody = handlerBody(IPC, 'external:agentScan');
  ok(scanBody.includes('isSilenced: (t) => isLanTerminalSilenced(sdb, t)'), 'I-12 扫描尊重既有静默名单');

  const DB = CODE(`${A}/src/main/database.ts`);
  eq(countOcc(DB, 'ADD COLUMN card_intents_json'), 1, 'I-13 迁移恰一处（门牌意图列）');

  const RIPC = CODE(`${A}/renderer/src/lib/ipc.ts`);
  for (const m of ['agentList:', 'agentProbe:', 'agentScan:', 'agentRequest:', 'agentIgnore:']) {
    eq(countOcc(RIPC, m), 1, `I-14 renderer 桥上 ${m} 恰一处`);
  }

  const PEERS = CODE(`${A}/renderer/src/pages/PeersPage.tsx`);
  ok(PEERS.includes('通用 AI 终端发现'), 'I-15 协同面板有发现区块');
  ok(PEERS.includes("p.source === 'discovery'") && PEERS.includes('A2A 地址发现'), 'I-16 待批行标出 A2A 来路');
  ok(PEERS.includes('externalApi.agentRequest('), 'I-17 界面真能发起接入');
  ok(PEERS.includes('externalApi.agentScan('), 'I-18 界面真能发起扫描');

  const INBOX = CODE(`${A}/renderer/src/pages/InboxPage.tsx`);
  ok(INBOX.includes("t.source === 'discovery'") && INBOX.includes('A2A 地址发现'),
    'I-19 授权台同源标出来路');

  const AINBOX = CODE(`${A}/src/main/core/im/approval-inbox.ts`);
  ok(AINBOX.includes("t.source === 'discovery'") && AINBOX.includes('A2A 地址发现'),
    'I-20 IM 授权台同源标出来路');

  const EXT = CODE(`${A}/src/main/core/external-terminals.ts`);
  ok(EXT.includes("raw === 'discovery'"), 'I-21 来路归一认得 discovery');
  ok(EXT.includes('card_intents_json'), 'I-22 意图列的读写都在本模块');
  ok(EXT.includes('negotiateTerminalMode('), 'I-23 协商在同一读口现算（只有一份）');
  ok(countOcc(EXT, "opts.source === 'discovery'") >= 1, 'I-24 写来路时把 discovery 纳入');

  const DISC = CODE(`${A}/src/main/core/agent-discovery.ts`);
  ok(!DISC.includes('wa_external_terminals') && !DISC.includes('better-sqlite3') && !DISC.includes("from 'electron'"),
    'I-25 发现模块不落库、不依赖 electron（看见 ≠ 进门）');
  ok(DISC.includes('INBOUND_AGENT_CARD_PATH') && DISC.includes('INBOUND_WELL_KNOWN_PATH'),
    'I-26 门牌路径复用入站门常量（不手抄）');
  ok(isPrivateAddress('192.168.1.2') && !isPrivateAddress('8.8.8.8'), 'I-27 私网围栏引用既有判据');
}

async function main(): Promise<void> {
  sectionA();
  sectionB();
  sectionC();
  await sectionD();
  await sectionE();
  sectionF();
  await sectionG();
  sectionH();
  await sectionHScan();
  sectionI();
  checkBuildPins(ok);
  console.log(`\n汇总：${pass} 通过 / ${fail} 失败`);
  if (fail > 0) process.exit(1);
}

void main();
