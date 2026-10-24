/**
 * zx_20261016_1 受控复跑 —— 「应」：**门里得有人应声，回音得是本尊**。
 *
 * 本轮口径一句话（周易·乾·文言「同声相应，同气相求」／道德经·图难于其易 ／ 毛选·没有调查没有发言权 ／
 *   维特根斯坦·意义即用法 ／ 王阳明·知行合一 ／ 罗尔斯·无知之幕 ／ 庄子·不预设）：
 *   ① 回执必须是**本次那一条**的回音（不是隔壁设备的、不是上一轮残留订阅的）；
 *   ② 门开了就得**有人应声**——用户不在电脑前，也能在 IM 里把机器人放进来。
 *
 * ── 纪律（承 auto-memory 各条）──────────────────────────────────────────────
 *   G-1 **用生产函数**：判据静态导入生产导出（被删/改名即编译期失败）；能跑真实现的一律跑真实现。
 *   G-2 **两侧标本**：凡判"不该命中"的判据，必有"该命中"的正标本 + 反证标本。
 *   G-5 判"用户可见文案/接线在册"读 `CODE()`（去注释）后的代码；注释**不能**替实现签字。
 *   G-6 **无轮次字面量**：本文件不得出现任何 `zx_…` 字面量（末尾 S1 自检兜底）。
 *
 * ── 分批（逐批长大的组）──────────────────────────────────────────────────────
 *   **K 组** = 批一 控制面止血（D1 假回执 / D2 订阅泄漏 / D3 连接不关停）。
 *   **N 组** = 批二 配对申请推得到人（出站：1:1 私聊目标 + 同本补发账 + 不聚并）。
 *   **P 组** = 批三 IM 回复即审批（入站：解析 + 歧义列候选 + 真落库 `pending→approved`）。
 *   **S 组** = 哑雷自检 + build 钉。
 *
 *   ⚠ 夹具：**假 `MqttClientLike`**（不触网、不真开 broker、不依赖 `mqtt` 装没装）；
 *     N/P 组用 `node:sqlite` 内存库，按**生产 DDL** 建表（`feedback_rr_fixture_production_order`）。
 *   ⚠ 计数器类断言须有 **0→1** 正面断言（被 `try/catch` 吞掉的写入只有正面断言抓得住）。
 *   ⚠ rr 起不了 electron ⇒ `pushImOwnerNotice` 的**真送达**照不出、只照得出**落账**（N-3 即此边界）；
 *     "目标解析/审批落库"两类判据则真跑生产实现本体。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';
// G-1：控制路径的真实现（本次三刀的落点）——静态导入，改名/删除即编译期失败。
import {
  publishAndAwaitState, closeMqttClients, __mqttClientsForTest,
  mqttAddress, DEFAULT_MQTT_PORT,
  type MqttClientLike,
} from '../apps/worker-ant-desktop/src/main/core/device-mqtt.js';
import type { AnsDevice } from '../apps/worker-ant-desktop/src/main/core/device-registry.js';
// G-1：批二/批三的真实现（配对通知 + 回复解析 + 审批动作）——静态导入，改名/删除即编译期失败。
import {
  buildPairNotice, parsePairReply, resolvePairTarget,
  approveTerminal, rejectTerminal, createPairRequest, listPendingTerminals,
  type TerminalDb,
} from '../apps/worker-ant-desktop/src/main/core/external-terminals.js';
import { resolveOwnerTargets, pushImOwnerNotice } from '../apps/worker-ant-desktop/src/main/core/im/im-notify.js';
import type { ImDb } from '../apps/worker-ant-desktop/src/main/core/im/im-db.js';

let pass = 0; let fail = 0;

function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
/** 等值断言（把实际值一并打出——红的时候要能立刻看出"差在哪"）。 */
function eq(actual: unknown, expect: unknown, label: string): void {
  const a = JSON.stringify(actual); const e = JSON.stringify(expect);
  ok(a === e, label, `${a} vs ${e}`);
}

const root = path.join(__dirname, '..');
const A = 'apps/worker-ant-desktop';
const RD = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf-8');
const CODE = (rel: string) => stripKeepingLines(RD(rel)).join('\n');

/** 本套件轮次标识由**载体自身**派生（G-6：不写"只为下一轮为真"的字面量）。 */
const SELF_ROUND = path.basename(__filename).replace(/^rr_/, '').replace(/\.ts$/, ''); // zx_20261016_1

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 一台"MQTT 灯"夹具（`cmd:`/`state:` 自述齐备——判据全由能力串派生，不预设）。 */
const mqttLamp = (o: Partial<AnsDevice> = {}): AnsDevice => ({
  id: 'd-mqtt-1', name: '客厅灯', alias: '', kind: 'light', protocol: 'mqtt',
  address: mqttAddress('192.168.1.9', 'lamp1'), port: DEFAULT_MQTT_PORT,
  capabilities: ['mqtt', 'cmd:home/lamp1/set', 'state:home/lamp1/state'],
  controllable: true, authorized: false, status: null, first_seen: '', last_seen: '', ...o,
});

/**
 * 假客户端：**记录** subscribe/unsubscribe/end 调用与 on 监听器，`emit` 手动投递消息。
 * `withUnsubscribe:false` ⇒ **不实现** `unsubscribe`（可选方法缺席的降级标本，K-4）。
 */
interface FakeClient extends MqttClientLike {
  listeners: Array<{ ev: string; cb: (...a: unknown[]) => void }>;
  subscribed: string[];
  unsubscribed: string[];
  ended: Array<boolean | undefined>;
  emit(ev: string, ...args: unknown[]): void;
}
function makeFakeClient(opts: { withUnsubscribe?: boolean } = {}): FakeClient {
  const listeners: Array<{ ev: string; cb: (...a: unknown[]) => void }> = [];
  const subscribed: string[] = [];
  const unsubscribed: string[] = [];
  const ended: Array<boolean | undefined> = [];
  const c: FakeClient = {
    connected: true,
    listeners, subscribed, unsubscribed, ended,
    on(ev, cb) { listeners.push({ ev, cb }); },
    removeListener(ev, cb) {
      const i = listeners.findIndex((l) => l.ev === ev && l.cb === cb);
      if (i >= 0) listeners.splice(i, 1);
    },
    publish(_t, _p, _o, cb) { queueMicrotask(() => cb()); },
    subscribe(topic) { subscribed.push(topic); },
    end(force) { ended.push(force); },
    emit(ev, ...args) { for (const l of [...listeners]) if (l.ev === ev) l.cb(...args); },
  };
  if (opts.withUnsubscribe !== false) c.unsubscribe = (topic: string): void => { unsubscribed.push(topic); };
  return c;
}

/** 终端夹具库：只建 `wa_external_terminals`（DDL 逐字取自生产 `database.ts:418`）。 */
function mkTerminalDb(): DatabaseSync {
  const d = new DatabaseSync(':memory:');
  d.exec(`CREATE TABLE wa_external_terminals (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    pair_code TEXT NOT NULL, key_prefix TEXT, secret_hash TEXT,
    capabilities_json TEXT NOT NULL DEFAULT '[]', last_remote_addr TEXT, last_seen_at TEXT,
    created_at TEXT DEFAULT (datetime('now')), approved_at TEXT, revoked_at TEXT, delivered_at TEXT,
    grant_expires_at TEXT)`);
  return d;
}

/** 通知夹具库：`wa_im_channels`/`wa_im_conversations`/`wa_im_outbox`（DDL 取自生产 `database.ts`）。 */
function mkNotifyDb(): DatabaseSync {
  const d = new DatabaseSync(':memory:');
  d.exec("CREATE TABLE wa_im_channels (id TEXT PRIMARY KEY, channel_type TEXT NOT NULL, name TEXT DEFAULT '', status TEXT DEFAULT 'active', created_at TEXT DEFAULT (datetime('now')));");
  d.exec(`CREATE TABLE wa_im_conversations (
    id TEXT PRIMARY KEY, channel_id TEXT, external_user_id TEXT, project_id TEXT, message_json TEXT DEFAULT '{}',
    direction TEXT DEFAULT 'inbound', created_at TEXT DEFAULT (datetime('now')), status TEXT DEFAULT 'sent',
    last_error TEXT DEFAULT '', outbox_id TEXT DEFAULT '', task_id TEXT DEFAULT '');`);
  d.exec(`CREATE TABLE wa_im_outbox (
    id TEXT PRIMARY KEY, channel_id TEXT, external_user_id TEXT, task_id TEXT, kind TEXT DEFAULT 'notification',
    message TEXT DEFAULT '', attempts INTEGER DEFAULT 0, status TEXT DEFAULT 'pending', next_retry_at INTEGER,
    created_at TEXT DEFAULT (datetime('now')), last_error TEXT);`);
  return d;
}

// ══════════════════════════════════════════════════════════════════
async function main(): Promise<void> {

  // ═══ K｜批一 · 控制面止血（回执认主题 + 订阅收支平衡 + 关停收摊）══════════════════════════
  console.log('\n【K】批一 控制面止血（D1 假回执 / D2 订阅泄漏 / D3 连接不关停；假客户端 ⇒ 不触网）');
  {
    // ── K-1 ★★回执认主题：**隔壁设备**的 `state` 不得判成本次"已回执"───────────────────────
    {
      const c = makeFakeClient();
      const dev = mqttLamp(); // state:home/lamp1/state
      let settled = false;
      const p = publishAndAwaitState(c, dev, 'home/lamp1/set', 'ON');
      void p.then(() => { settled = true; });
      eq(c.subscribed, ['home/lamp1/state'], 'K-1a ★订阅的是**自述的那个** state 主题（0→1 正面断言）');
      c.emit('message', 'home/lamp2/state', '别的设备的抖动');   // 他设备主题
      await tick(30);
      ok(!settled, 'K-1b ★★**他设备主题**的消息不得判成本次已回执（修复前：任意 message 即 finish）');
      c.emit('message', 'home/lamp1/state', 'ON');
      eq(await p, { ok: true, ack: 'ON' }, 'K-1c ★**本次那条**主题的消息才作回执（引号内容原样带出）');
    }

    // ── K-1d ★★反证（超时语义一字不动）：窗口内只有他设备动静 ⇒ 如实回"设备没回"，不假装成功──
    {
      const c = makeFakeClient();
      const p = publishAndAwaitState(c, mqttLamp(), 'home/lamp1/set', 'ON');
      c.emit('message', 'home/lamp2/state', '噪声');
      eq(await p, { ok: true, ack: null },
        'K-1d ★★窗口内无本主题回执 ⇒ 退化为 broker PUBACK 并**如实说明**（`ack:null`，不拿噪声冒充回执）');
    }

    // ── K-2 ★★同主题并发 ⇒ 订阅恰一次、退订恰一次（引用计数 0→1 / 1→0）─────────────────────
    {
      const c = makeFakeClient();
      const dev = mqttLamp();
      const p1 = publishAndAwaitState(c, dev, 'home/lamp1/set', 'A');
      const p2 = publishAndAwaitState(c, dev, 'home/lamp1/set', 'B');
      eq(c.subscribed, ['home/lamp1/state'], 'K-2a ★两条并发同主题 ⇒ `subscribe` 恰一次（不是两次）');
      c.emit('message', 'home/lamp1/state', 'ON');
      eq([await p1, await p2], [{ ok: true, ack: 'ON' }, { ok: true, ack: 'ON' }], 'K-2b 两条都收得到这一条回执');
      eq(c.unsubscribed, ['home/lamp1/state'], 'K-2c ★★计数归零才退订 ⇒ `unsubscribe` 恰一次（先退的那条不得把后一条的订阅拆了）');
    }

    // ── K-3 ★反证：两条**不同**主题并发互不串（各自退各自的）───────────────────────────────
    {
      const c = makeFakeClient();
      const devA = mqttLamp({ id: 'd-a', capabilities: ['mqtt', 'cmd:a/set', 'state:a/state'] });
      const devB = mqttLamp({ id: 'd-b', capabilities: ['mqtt', 'cmd:b/set', 'state:b/state'] });
      let aSettled = false;
      const pa = publishAndAwaitState(c, devA, 'a/set', 'A');
      void pa.then(() => { aSettled = true; });
      const pb = publishAndAwaitState(c, devB, 'b/set', 'B');
      eq(c.subscribed.slice().sort(), ['a/state', 'b/state'], 'K-3a 两条各订各的主题');
      c.emit('message', 'b/state', 'B-ACK');
      eq(await pb, { ok: true, ack: 'B-ACK' }, 'K-3b B 收到自己的回执');
      await tick(10);
      ok(!aSettled, 'K-3c ★反证：B 的回执**没**把 A 判成已回执（同一把尺两个方向都成立）');
      c.emit('message', 'a/state', 'A-ACK');
      eq(await pa, { ok: true, ack: 'A-ACK' }, 'K-3d A 随后收到自己的回执');
      eq(c.unsubscribed.slice().sort(), ['a/state', 'b/state'], 'K-3e 两条各自退订（互不牵连）');
    }

    // ── K-4 ★可选方法缺席的降级：假客户端**没有** `unsubscribe` 也照跑（不许抛）─────────────
    {
      const c = makeFakeClient({ withUnsubscribe: false });
      ok(c.unsubscribe === undefined, 'K-4a 夹具确为"无 `unsubscribe`"（标本本身可信）');
      let thrown: string | null = null;
      let r: unknown = null;
      try {
        const p = publishAndAwaitState(c, mqttLamp(), 'home/lamp1/set', 'ON');
        c.emit('message', 'home/lamp1/state', 'ON');
        r = await p;
      } catch (e) { thrown = (e as Error).message; }
      eq([thrown, r], [null, { ok: true, ack: 'ON' }],
        'K-4b ★★旧假客户端（不实现新可选方法）**不编译错也不运行错**——可选链降级，退订静默省去');
      eq(c.subscribed, ['home/lamp1/state'], 'K-4c 订阅照发（降级只影响"退不退"，不影响"订不订"）');
    }

    // ── K-5 ★★关停收摊：`closeMqttClients` 真 `end(true)` 且清空（修复前恒不关停）────────────
    {
      __mqttClientsForTest.clear(); // 清场：本组断言"从 0 变 2 再变 0"，不依赖他处残留
      eq(__mqttClientsForTest.size, 0, 'K-5a 前态：复用连接表为空（0 起点）');
      const c1 = makeFakeClient(); const c2 = makeFakeClient();
      __mqttClientsForTest.set('mqtt://192.168.1.9:1883', c1);
      __mqttClientsForTest.set('mqtt://192.168.1.10:1883', c2);
      eq(__mqttClientsForTest.size, 2, 'K-5b ★装两台假连接进表（0→2 正面断言）');
      closeMqttClients();
      eq([c1.ended, c2.ended], [[true], [true]], 'K-5c ★★逐台 `end(true)`（强断，不留半死连接）');
      eq(__mqttClientsForTest.size, 0, 'K-5d ★★表已清空（2→0；不清则下次复用一台已死的连接）');
      closeMqttClients(); // 幂等
      eq(__mqttClientsForTest.size, 0, 'K-5e 再调一次不抛（幂等空操作）');
    }

    // ── K-6 ★接线钉：`stopCore()` 真调用 `closeMqttClients()`（读**去注释**码，注释不能替实现签字）──
    {
      const idx = CODE(`${A}/src/main/index.ts`);
      const seg = idx.slice(idx.indexOf('async function stopCore'), idx.indexOf('function createWindow'));
      ok(seg.length > 0, 'K-6a 取到 `stopCore` 处理体（按处理体定扫描起点）');
      ok(/closeMqttClients\s*\(\s*\)/.test(seg),
        'K-6b ★★关停那一跳在册：`stopCore()` 内真调 `closeMqttClients()`（只定义不调＝"做了没用上"）');
      const mqttSrc = CODE(`${A}/src/main/core/device-mqtt.ts`);
      ok(/export function closeMqttClients\(\): void \{[\s\S]{0,200}?clients\.clear\(\);/.test(mqttSrc),
        'K-6c ★`closeMqttClients` 本体遍历并 `clients.clear()`（清表与 end 同处，不两处维护）');
      ok(/if \(String\(t\) !== stateTopic\) return;/.test(mqttSrc),
        'K-6d ★★D1 守门那一行在册：`onMessage` 首行按主题筛（抠掉它即回到"任意 message 即回执"）');
    }
  }

  // ═══ N｜批二 · 配对申请推得到人（出站；真跑 im-notify 的 `resolveOwnerTargets`/`pushImOwnerNotice`）══
  console.log('\n【N】批二 配对申请推得到人（1:1 私聊目标解析 + 同本补发账 + 不聚并）');
  {
    // ── N-1 ★通知文案含**全名与核对码**（纯函数；用户凭这两样决定放不放进来）─────────────────
    {
      const msg = buildPairNotice({ name: '测试机器人', pairCode: '654321' });
      ok(msg.includes('测试机器人'), 'N-1a 通知含终端**自述名**（不是"某终端"这类不可核对的泛称）', msg.slice(0, 60));
      ok(msg.includes('654321'), 'N-1b ★通知含**核对码**（用户回话时要照抄它）');
      ok(/同意接入/.test(msg) && /拒绝接入/.test(msg), 'N-1c ★通知给出**两条完整可照抄的命令形状**（文案与 `parsePairReply` 同源）');
      ok(parsePairReply(`同意接入 654321`) !== null, 'N-1d ★文案里那条命令**真能被解析器认下**（说明书与机器同源，不是各说各话）');
    }

    // ── N-2 ★★目标解析只取 1:1 私聊（反证：群聊/房间**都更晚**却都不入围）───────────────────
    {
      const fdb = mkNotifyDb() as unknown as ImDb;
      fdb.prepare("INSERT INTO wa_im_channels (id, channel_type, status) VALUES ('ch-dt','dingtalk','active'),('ch-wx','wechat-personal','active'),('ch-old','qqbot','inactive')").run();
      // 群聊(11:00)与房间(12:00)都**比唯一那条 1:1(09:00) 新** —— 排除谓词失效时挑出来的就是它们。
      fdb.prepare(`INSERT INTO wa_im_conversations (id, channel_id, external_user_id, message_json, direction, created_at) VALUES
        ('c1','ch-wx','u-direct','{"chat_type":"direct"}','inbound','2026-10-16 09:00:00'),
        ('c2','ch-dt','u-group','{"chat_type":"group"}','inbound','2026-10-16 11:00:00'),
        ('c3','ch-dt','12345@chatroom','{"chat_type":"direct"}','inbound','2026-10-16 12:00:00')`).run();
      const t = resolveOwnerTargets(fdb);
      eq(t.length, 1, 'N-2a ★★恰一个目标（不是"全渠道广播"）');
      eq([t[0]?.channelId, t[0]?.externalUserId], ['ch-wx', 'u-direct'],
        'N-2b ★★取的是**那条 1:1 私聊**——群聊(11:00)/房间(12:00)都比它新却没被选中（排除谓词真在生效）');
    }

    // ── N-2c ★反证：库里**只有**群聊/房间 ⇒ 零目标（宁可没人可推，也不投给群聊路人）───────────
    {
      const fdb = mkNotifyDb() as unknown as ImDb;
      fdb.prepare("INSERT INTO wa_im_channels (id, channel_type, status) VALUES ('ch-dt','dingtalk','active')").run();
      fdb.prepare(`INSERT INTO wa_im_conversations (id, channel_id, external_user_id, message_json, direction, created_at) VALUES
        ('g1','ch-dt','u-group','{"chat_type":"group"}','inbound','2026-10-16 11:00:00'),
        ('r1','ch-dt','12345@chatroom','{"chat_type":"direct"}','inbound','2026-10-16 12:00:00')`).run();
      eq(resolveOwnerTargets(fdb), [], 'N-2c ★反证：只有群聊/房间 ⇒ **零目标**（不把申请投进群）');
    }

    // ── N-3 ★★推送走 `sendTextToTargets`（同一本补发账）——真跑，`wa_im_outbox` 0→1 ───────────
    {
      const fdb = mkNotifyDb() as unknown as ImDb;
      fdb.prepare("INSERT INTO wa_im_channels (id, channel_type, status) VALUES ('ch-wx','wechat-personal','active')").run();
      fdb.prepare(`INSERT INTO wa_im_conversations (id, channel_id, external_user_id, message_json, direction, created_at)
        VALUES ('c1','ch-wx','u-direct','{"chat_type":"direct"}','inbound','2026-10-16 09:00:00')`).run();
      const before = (fdb.prepare('SELECT COUNT(*) c FROM wa_im_outbox').get() as { c: number }).c;
      eq(before, 0, 'N-3a 前态：补发账为空（0 起点）');
      // rr 跑在 node 里、起不了 electron ⇒ `sendTextToTargets` 的发送模块取不到，**必然**走落账那一跳
      //   （这正是本仓"受控回归照不出真送达、只照得出落账"的既有边界，见 im-notify-log.ts 头注）。
      await pushImOwnerNotice(fdb, buildPairNotice({ name: '机器人A', pairCode: '111111' }), 'external_pairing');
      const after = (fdb.prepare('SELECT COUNT(*) c FROM wa_im_outbox').get() as { c: number }).c;
      eq(after - before, 1, 'N-3b ★★推送**真落进 `wa_im_outbox`**（同一本补发账）——0→1 正面断言，不是"不抛"');
      const row = fdb.prepare('SELECT channel_id, external_user_id, task_id, kind FROM wa_im_outbox LIMIT 1').get() as { channel_id: string; external_user_id: string; task_id: string; kind: string };
      eq([row.channel_id, row.external_user_id, row.kind], ['ch-wx', 'u-direct', 'external_pairing'],
        'N-3c 落账明细：目标＝那条 1:1 私聊、类目＝`external_pairing`');
      eq(row.task_id, '', 'N-3d `task_id` 落**空串**（配对本无任务；`wa_im_outbox.task_id` 是可空 TEXT ⇒ 安全）');
    }

    // ── N-4 ★★不聚并：两条申请**都真发**（反证"静默吞掉一次申请"）────────────────────────────
    {
      const fdb = mkNotifyDb() as unknown as ImDb;
      fdb.prepare("INSERT INTO wa_im_channels (id, channel_type, status) VALUES ('ch-wx','wechat-personal','active')").run();
      fdb.prepare(`INSERT INTO wa_im_conversations (id, channel_id, external_user_id, message_json, direction, created_at)
        VALUES ('c1','ch-wx','u-direct','{"chat_type":"direct"}','inbound','2026-10-16 09:00:00')`).run();
      await pushImOwnerNotice(fdb, buildPairNotice({ name: '机器人A', pairCode: '111111' }), 'external_pairing');
      await pushImOwnerNotice(fdb, buildPairNotice({ name: '机器人B', pairCode: '222222' }), 'external_pairing');
      const n = (fdb.prepare('SELECT COUNT(*) c FROM wa_im_outbox').get() as { c: number }).c;
      eq(n, 2, 'N-4a ★★两条申请 ⇒ 补发账 **2 行**（0→2）：两台机器人**都真发**过，没有一条被静默吞掉');

      // N-4b 结构性：`pushImOwnerNotice` 本体**不得**出现 `recordNotifyIntent`（那是按项目/任务聚并的账）。
      const src = CODE(`${A}/src/main/core/im/im-notify.ts`);
      const i = src.indexOf('export async function pushImOwnerNotice');
      const j = src.indexOf('async function sendTextToTargets');
      const body = i >= 0 && j > i ? src.slice(i, j) : '';
      ok(body.length > 0, 'N-4b 取到 `pushImOwnerNotice` 处理体（按处理体定扫描起点）');
      ok(!/recordNotifyIntent/.test(body),
        'N-4c ★★本体**不过 `recordNotifyIntent`**（走了它＝给"两台机器人先后申请"造一个静默吞并的窗口）');
      ok(/sendTextToTargets\(db, '', targets, message, kind\)/.test(body),
        'N-4d ★本体只做"解析目标 → 同一本 `sendTextToTargets`"（一处真源，不另开一本账）');
    }

    // ── N-5 ★接线那一跳：`index.ts` 的 `requestPair` 真调 `pushImOwnerNotice`（读去注释码）──────
    {
      const idx = CODE(`${A}/src/main/index.ts`);
      const i = idx.indexOf('const pairing: PairingPort');
      const j = idx.indexOf('startInboundGate(');
      const seg = i >= 0 && j > i ? idx.slice(i, j) : '';
      ok(seg.length > 0, 'N-5a 取到 `pairing` 包装处（按处理体定扫描起点）');
      ok(/requestPair:\s*\(name, remoteAddr\)/.test(seg) && /basePairing\.requestPair\(name, remoteAddr\)/.test(seg),
        'N-5b 包装**转发真实现**（不是另起一份配对逻辑）');
      ok(/pushImOwnerNotice\(db!, buildPairNotice\(/.test(seg),
        'N-5c ★★推送那一跳在册：`requestPair` 内真调 `pushImOwnerNotice(db!, buildPairNotice(...))`（只定义不调＝"做了没用上"）');
      ok(/\.catch\(/.test(seg), 'N-5d ★推送是**旁路**：`.catch` 兜住（失败不阻断配对，也不静默）');
      ok(/return r;/.test(seg), 'N-5e ★`requestPair` **原样返回** `basePairing` 的结果（推送不改配对语义）');
    }
  }

  // ═══ P｜批三 · IM 回复即审批（入站；真跑解析器 + 真落库）════════════════════════════════
  console.log('\n【P】批三 IM 回复即审批（解析逐形态 + 歧义列候选 + 真落库 pending→approved）');
  {
    // ── P-1 逐形态解析（带码/无码 × 同意/拒绝 × 容错标点）──────────────────────────────────
    {
      eq(parsePairReply('同意接入 123456'), { kind: 'approve', code: '123456' }, 'P-1a 「同意接入 123456」⇒ approve + 码');
      eq(parsePairReply('拒绝接入 123456'), { kind: 'reject', code: '123456' }, 'P-1b 「拒绝接入 123456」⇒ reject + 码');
      eq(parsePairReply('同意接入'), { kind: 'approve', code: null }, 'P-1c 无码「同意接入」⇒ approve + `code:null`');
      eq(parsePairReply('  允许接入  654321 ！ '), { kind: 'approve', code: '654321' }, 'P-1d 容忍空白/全角标点/多种同意动词');
      eq(parsePairReply('不接受接入'), { kind: 'reject', code: null }, 'P-1e 「不接受接入」⇒ reject（拒绝侧谓词覆盖）');
    }

    // ── P-2 ★★反证：裸「同意」「是」等**不得**被本路认领（那是任务审批的语义）─────────────────
    {
      for (const s of ['同意', '是', '确认', '好的', '允许', '拒绝', '接入', '同意接入设备']) {
        eq(parsePairReply(s), null, `P-2 ★反证：「${s}」不被本路认领（仍归任务审批/既有链路）`);
      }
    }

    // ── P-3 带码无相符 ⇒ `none`（不猜；含码打错、申请已被别处批掉）───────────────────────────
    {
      const db = mkTerminalDb() as unknown as TerminalDb;
      createPairRequest(db, '机器人A');
      eq(resolvePairTarget(db, '000000').kind, 'none', 'P-3a ★带码但**无相符** ⇒ `none`（不猜成那唯一一条）');
      eq(resolvePairTarget(db, null).kind, 'ok', 'P-3b 无码而待批恰一条 ⇒ `ok`（唯一一条可定）');
    }

    // ── P-4 ★★无码多条 ⇒ `ambiguous` 列候选（**不批**）────────────────────────────────────
    {
      const db = mkTerminalDb() as unknown as TerminalDb;
      createPairRequest(db, '机器人A');
      createPairRequest(db, '机器人B');
      const r = resolvePairTarget(db, null);
      eq(r.kind, 'ambiguous', 'P-4a ★★无码而待批**多条** ⇒ `ambiguous`（列候选，不猜、不批）');
      eq(r.kind === 'ambiguous' ? r.pendings.map((p) => p.name).sort() : [], ['机器人A', '机器人B'],
        'P-4b 候选**逐条列出**（用户据此补上核对码再回话）');
      eq(resolvePairTarget(db, '000000').kind, 'none', 'P-4c ★反证：码不符时即使只有两条也**不猜**');
    }

    // ── P-5 ★★真落库：`approveTerminal` 把 `pending → approved`（值从 0 变 1）────────────────
    {
      const db = mkTerminalDb() as unknown as TerminalDb;
      const { pairingId } = createPairRequest(db, '机器人A');
      eq((db.prepare('SELECT status FROM wa_external_terminals WHERE id = ?').get(pairingId) as { status: string }).status, 'pending', 'P-5a 前态：`pending`（0 起点）');
      const r = approveTerminal(db, pairingId, []);
      eq(r.ok, true, 'P-5b `approveTerminal` 如实回 ok');
      const row = db.prepare('SELECT status, key_prefix, secret_hash FROM wa_external_terminals WHERE id = ?').get(pairingId) as { status: string; key_prefix: string | null; secret_hash: string | null };
      eq(row.status, 'approved', 'P-5c ★★值从 0 变 1：`pending → approved`（知而不行只是未知——真落库才算数）');
      ok(!!row.key_prefix && !!row.secret_hash, 'P-5d ★真铸凭据（只存 hash：`secret_hash` 非空、明文不落库）');
      eq(listPendingTerminals(db).length, 0, 'P-5e 待批列表 1→0（批过的离开待批区）');
    }

    // ── P-6 ★拒绝同尺：`rejectTerminal` 真落库 `pending → rejected` ────────────────────────────
    {
      const db = mkTerminalDb() as unknown as TerminalDb;
      const { pairingId } = createPairRequest(db, '机器人B');
      const r = rejectTerminal(db, pairingId);
      eq(r.ok, true, 'P-6a `rejectTerminal` 如实回 ok');
      eq((db.prepare('SELECT status FROM wa_external_terminals WHERE id = ?').get(pairingId) as { status: string }).status, 'rejected',
        'P-6b ★`pending → rejected`（真落库，不是只回一句话）');
      eq(listPendingTerminals(db).length, 0, 'P-6c 待批列表 1→0');
    }

    // ── P-7 ★路由次序：新臂在**步骤-2 之后、步骤0 之前**（按处理体定扫描起点）─────────────────
    {
      const src = CODE(`${A}/src/main/services/im-router.ts`);
      const iNum = src.indexOf('if (handleNumberSelection(ctx, fromUser, msgText)) return;');
      const iPair = src.indexOf('if (handleTerminalPairReply(ctx, fromUser, msgText)) return;');
      const iAppr = src.indexOf('if (checkPendingApproval(ctx, fromUser, msgText)) return;');
      ok(iNum >= 0 && iPair > iNum, 'P-7a ★新臂**在步骤-2（编号选择）之后**');
      ok(iAppr > iPair, 'P-7b ★★新臂**在步骤0（任务审批队列）之前**——否则「同意接入 X」可能先被自由回复吃掉');
      ok(/resolvePairTarget\(ctx\.db/.test(src) && /approveTerminal\(ctx\.db/.test(src) && /rejectTerminal\(ctx\.db/.test(src),
        'P-7c 新臂调用的是**生产审批写口**（`approveTerminal`/`rejectTerminal`，不另开一套队列）');
      ok(/target\.kind === 'none'\) return false;/.test(src), 'P-7d ★`none` ⇒ **不认领**（没有申请时说「同意接入」落回既有链路，不静默）');
      ok(/target\.kind === 'ambiguous'/.test(src), 'P-7e ★歧义分支在册（列候选不批）');
    }

    // ── P-8 ★帮助词表逐条枚举含新指令（`BUILTIN_IM_COMMANDS` 是帮助那一栏的唯一产出点）──────────
    {
      const { BUILTIN_IM_COMMANDS } = await import('../apps/worker-ant-desktop/src/main/services/im-commands.js');
      const entry = BUILTIN_IM_COMMANDS.find((c) => c.name === '接入审批');
      ok(!!entry, 'P-8a 帮助表新增「接入审批」一条');
      ok(!!entry && entry.match(entry.probe) && entry.match('拒绝接入 123456'),
        'P-8b 该行的谓词认下**同意/拒绝两侧**（不是只认一侧）', entry?.probe);
      ok(!!entry && !entry.match('是') && !entry.match('同意'),
        'P-8c ★反证：该行**不认**裸「是」/「同意」（不越界吃掉任务审批语义）');
      ok(/BUILTIN_IM_COMMANDS/.test(CODE(`${A}/src/main/services/im-router.ts`)), 'P-8d 帮助仍由表派生（未另抄一份）');
    }
  }

  // ═══ S｜哑雷自检 + build 钉（派生核对，不写轮次字面量）════════════════════════════
  console.log('\n【S】哑雷自检 + build 钉（派生核对，不写轮次字面量）');
  {
    const selfLines = stripKeepingLines(RD(`scripts/${path.basename(__filename)}`)).join('\n');
    const selfPins = [...selfLines.matchAll(/(?<![A-Za-z0-9_])(?:build:\s*|ROUND\s*=\s*|includes\()'(zx_[0-9_]+)'/g)];
    ok(selfPins.length === 0, 'S1 本文件零 build 轮次字面量（G-6：不写"只为下一轮"的哑雷）',
      selfPins.map((m) => m[1]).join(',') || '0 处');
    ok(/zx_\d{8}/.test(SELF_ROUND) && fs.existsSync(path.join(root, `plans/improve/${SELF_ROUND}.md`)),
      'S2 ★方向性自指（由载体自身派生）：本轮方案文件在场', `plans/improve/${SELF_ROUND}.md`);
    ok(fs.existsSync(path.join(root, `scripts/rr_${SELF_ROUND}.ts`)),
      'S3 本套件在册（脚本名由载体派生）', `scripts/rr_${SELF_ROUND}.ts`);

    checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });
  }
}

// ⚠ `catch` 不可省：夹具/断言**抛异常**时若只挂 `finally`，`process.exit` 会在 Node 报告 unhandled
//   rejection **之前**把进程带走 ⇒ 跑到一半崩掉的复跑会打出一行 ✅ 假绿。
main().then(() => {
  console.log(`\n${fail === 0 ? '✅' : '❌'} rr_zx_20261016_1: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
}).catch((e: unknown) => {
  console.error(`\n💥 rr_zx_20261016_1 未捕获异常（复跑**未跑完**，不得读作通过）：`, e);
  fail++;
  console.log(`\n❌ rr_zx_20261016_1: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(1);
});
