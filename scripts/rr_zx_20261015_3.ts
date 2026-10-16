/**
 * zx_20261015_3 受控复跑 —— 「桥」：认 HA 的标准协议，一条缝见数百品牌；在场只认设备自述。
 *
 * 由来（2026-10-15）：`zx_20261013_1` 批五造的那把 MQTT 钥匙**只认工蚁自己的锁**（`{id,name,cmd}`）。
 *   本轮**配标准钥匙**——同一把钥匙（连接/发布/订阅），**多一种语言**：Home Assistant 的 **MQTT Discovery**
 *   标准协议。认了这一条缝，一家 HA 覆盖米家/涂鸦/美的/海尔…**数百品牌**，零厂商对接，且全部合规
 *   （对接的是**用户自己的** HA 实例）。这就是「不出户，知天下」（道德经·四十七章）——不逐家登门。
 *
 * 本轮口径一句话（道德经·四十七章 ／ 维特根斯坦·意义即用法 ／ 庄子·不预设 ／ 道德经·知止不殆）：
 *   · **不预设**：`kind`/`capabilities`/`controllable` 一律取自 **HA 自述**；认不出即退（`null`），不猜。
 *   · **两语言不混**：工蚁自有语言（`{action}`）与 HA 语言（`ON`/`~/config`）**互不代劳**——
 *     靠**主题范围**分开（各自只订各自的主题树），不靠载荷形状。
 *   · **知止不殆**：`online` **三态**（NULL=未知 / 1=在 / 0=不在）——`last_seen`（"我们何时见过"）
 *     **不许**冒充"它此刻在"；在线**只**由可用性事件（LWT/`avty` 主题）回填，**绝不**从发现载荷推。
 *
 * 治法（五批落点，逐条见方案 §2/§3.5）：
 *   批一 H `device-homeassistant.ts` 纯映射（主题/缩写/`~`/能力/载荷）；
 *   批二 W `device-mqtt.ts` `haCommandPayload`/`deviceCommandPayload` 选语言 + `subscribeIo`/`openSubscriber` 共用骨；
 *        `ipc/devices.ipc.ts` `devices:discover` 三路并联；
 *   批三 O `device-registry.ts` `setDeviceOnline`（唯一写点）+ `device-homeassistant.ts` 可用性订阅；
 *   批四 G `renderer/pages/DevicesPage.tsx` 在线三态徽章 + HA 桥配置块（GUI 读写口）。
 *   追加 V **第三方真实载荷回放**（`zx_20261016_1` 收口后）：把 Z2M/Tasmota/HA 文档的**原样载荷**喂生产码，
 *        照出"自造标本只会含我们想到的形状"这一盲区——本轮即照出缩写表 `stat_on→payload_on` 误映
 *        （实为状态语义 `state_on`）且漏 `pl_on`/`pl_off`（→`payload_on`/`payload_off`），已订正。
 *
 * ── 纪律（承 auto-memory 各条）──────────────────────────────────────────────
 *   G-1 **用生产函数**：H/W/O/V 组直引真实现（被删/改名即编译期失败），不复制一份判据。
 *   G-2 **两侧标本**：每处"该命中"必配**反证**（H-1 合规/不合规主题；H-6 认得出/认不出；
 *       O-3 discovery 载荷**不**置 online 的反证）；三态写须有**值从 0 变 1**的正面断言。
 *   G-6 **无轮次字面量**：方案路径/脚本名由 `path.basename(__filename)` 派生（末尾 S 组自检）。
 *   ⚠ 静态判据**按符号切片**（不按行号）；判"接线那一跳"读去注释后的代码（`stripKeepingLines`）。
 *   ⚠ 夹具 DDL 逐列照抄 `database.ts` 的 `wa_devices`（含迁移后的 `online` 列）——被查的列一列不缺。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';
// G-1：读真源**静态导入**（被删/改名即编译期失败，而非"扫个空、静默假绿"）。
import {
  parseHaDiscoveryTopic, expandHaTopic, haConfigToDevice, haAvailabilityOf, haAvailabilityOnline,
  haDiscoveryTopic, haDiscoveryIo, resolveHaConfig, HA_ABBREV,
} from '../apps/worker-ant-desktop/src/main/core/device-homeassistant.js';
import {
  haCommandPayload, deviceCommandPayload, mqttCommandPayload, mqttDiscoveryIo, mqttDeviceControl,
  type MqttSubscribeIo, type MqttIo,
} from '../apps/worker-ant-desktop/src/main/core/device-mqtt.js';
import { isHighRiskKind } from '../apps/worker-ant-desktop/src/main/core/device-registry.js';
import {
  upsertDiscovered, getDevice, setDeviceOnline, listDevices, findDeviceByIdentity, type AnsDevice,
} from '../apps/worker-ant-desktop/src/main/core/device-registry.js';

let pass = 0; let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
/** 等值断言（把实际值一并打出——红时立刻看得出差在哪）。 */
function eq(actual: unknown, expect: unknown, label: string): void {
  const a = JSON.stringify(actual); const e = JSON.stringify(expect);
  ok(a === e, label, `${a} vs ${e}`);
}

const root = path.join(__dirname, '..');
const A = 'apps/worker-ant-desktop';
const RD = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf-8');
/** 判"接线/文案形状"读**去注释后**的代码；判"注释在册"读原文。 */
const CODE = (rel: string) => stripKeepingLines(RD(rel)).join('\n');

/** 本套件轮次标识由**载体自身**派生（G-6：不写"只为下一轮为真"的字面量）。 */
const SELF_ROUND = path.basename(__filename).replace(/^rr_/, '').replace(/\.ts$/, '');

/* ── 夹具 schema：逐列照抄生产 `database.ts` 的 `wa_devices`（含迁移后的 `online` 列）────── */
const SCHEMA = `
CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_devices (id TEXT PRIMARY KEY, name TEXT DEFAULT '', alias TEXT DEFAULT '', kind TEXT DEFAULT 'unknown',
  protocol TEXT NOT NULL, address TEXT NOT NULL, port INTEGER, capabilities_json TEXT DEFAULT '[]',
  controllable INTEGER DEFAULT 0, authorized INTEGER DEFAULT 0, status_json TEXT,
  first_seen TEXT DEFAULT (datetime('now')), last_seen TEXT DEFAULT (datetime('now')), online INTEGER);
CREATE UNIQUE INDEX idx_wa_devices_ident ON wa_devices(protocol, address);
`;
type AnyDb = Parameters<typeof listDevices>[0];
const mkdb = (): DatabaseSync => { const d = new DatabaseSync(':memory:'); d.exec(SCHEMA); return d; };
const asDb = (d: DatabaseSync) => d as unknown as AnyDb;

/** 假订阅面（受控回归喂它 ⇒ 不触网）：记录订阅，`emit` **全量分发**给所有消费者（同真路径的骨）。 */
interface FakeSub { io: MqttSubscribeIo; subs: Array<{ topic: string; cb: (t: string, p: string) => void }>; emit(t: string, p: string): void; stopped(): boolean; }
function makeFakeSub(): FakeSub {
  const subs: Array<{ topic: string; cb: (t: string, p: string) => void }> = [];
  let stopped = false;
  return {
    io: {
      subscribe(topic, cb) { subs.push({ topic, cb }); },
      stop() { stopped = true; },
    },
    subs,
    emit(t, p) { for (const s of subs) { try { s.cb(t, p); } catch { /* 单消费者失败不拖垮 */ } } },
    stopped: () => stopped,
  };
}

/** 假 MQTT 传输（捕获 publish 载荷；MqttIo 同形）。 */
function makeFakePub(): { io: MqttIo; pubs: Array<{ topic: string; payload: string }> } {
  const pubs: Array<{ topic: string; payload: string }> = [];
  return { pubs, io: { async publish(_dev, topic, payload) { pubs.push({ topic, payload }); return { ok: true, ack: null }; } } };
}

const HA_DEV = (caps: string[], address = 'broker#dev1'): AnsDevice =>
  ({ address, port: 1883, capabilities: caps }) as unknown as AnsDevice;

async function main(): Promise<void> {
  // ═══ H｜HA 语言纯映射（批一 · 庄子·不预设 / 维特根斯坦·意义即用法）═════════════════════════════
  console.log('\n【H】HA 语言纯映射 —— 「不出户，知天下」（道德经·四十七章）');
  {
    // ── H-1 ★★主题解析两只标本（4 段/5 段命中）+ 反证（不合规 ⇒ null）──────────────────────
    eq(parseHaDiscoveryTopic('homeassistant/light/kitchen/config'),
      { component: 'light', nodeId: null, objectId: 'kitchen' }, 'H-1a 4 段式命中（无 node_id）');
    eq(parseHaDiscoveryTopic('homeassistant/light/node1/kitchen/config'),
      { component: 'light', nodeId: 'node1', objectId: 'kitchen' }, 'H-1b 5 段式命中（有 node_id）');
    eq(parseHaDiscoveryTopic('homeassistant/light/kitchen/state'), null, 'H-1c ★反证：末段非 `config` ⇒ null');
    eq(parseHaDiscoveryTopic('homeassistant/status'), null, 'H-1d ★反证：段数不足（`homeassistant/status` 是 HA 自身出生/遗嘱）⇒ null');
    eq(parseHaDiscoveryTopic('other/light/kitchen/config'), null, 'H-1e ★反证：前缀不符 ⇒ null');
    eq(parseHaDiscoveryTopic('homeassistantX/light/kitchen/config'), null, 'H-1f ★反证：前缀**逐段**匹配（`homeassistant` 不误吞 `homeassistantX`）');

    // ── H-2 ★★缩写展开（缩写与全称**并存两支**，全称优先）────────────────────────────────
    const byAbbr = haConfigToDevice('homeassistant/switch/p1/config',
      JSON.stringify({ cmd_t: 'p1/set', stat_t: 'p1/state' }), 'b', 1883);
    ok(byAbbr != null && byAbbr.capabilities.includes('cmd:p1/set') && byAbbr.capabilities.includes('state:p1/state'),
      'H-2a ★缩写 `cmd_t`/`stat_t` 展开成 `cmd:`/`state:` 能力', byAbbr?.capabilities.join(','));
    const byFull = haConfigToDevice('homeassistant/switch/p1/config',
      JSON.stringify({ command_topic: 'p1/set' }), 'b', 1883);
    ok(byFull != null && byFull.capabilities.includes('cmd:p1/set'), 'H-2b 全称写法同样认');
    const both = haConfigToDevice('homeassistant/switch/p1/config',
      JSON.stringify({ cmd_t: 'WRONG', command_topic: 'RIGHT' }), 'b', 1883);
    ok(both != null && both.capabilities.includes('cmd:RIGHT') && !both.capabilities.includes('cmd:WRONG'),
      'H-2c ★★缩写与全称**并存 ⇒ 全称优先**（不因缩写先到就取胜）', both?.capabilities.join(','));

    // ── H-3 ★★`~` 基主题展开（有基⇒替换；**无基⇒原样**，反证不误删）───────────────────────
    eq(expandHaTopic('~/set', 'dev1'), 'dev1/set', 'H-3a 有基主题 ⇒ `~` 全替换');
    eq(expandHaTopic('~/set', null), '~/set', 'H-3b ★反证：无基 ⇒ **原样**（"没有基"≠"要删 `~`"）');
    const tilde = haConfigToDevice('homeassistant/light/l1/config',
      JSON.stringify({ '~': 'l1', cmd_t: '~/set' }), 'b', 1883);
    ok(tilde != null && tilde.capabilities.includes('cmd:l1/set'),
      'H-3c ★`~` 展开**接进** capabilities（不是只在助手函数里成立）', tilde?.capabilities.join(','));

    // ── H-4 ★`kind` = HA `component` 逐字（已自述的类别，不猜）；`lock` 命中既有高危闸 ─────
    const lock = haConfigToDevice('homeassistant/lock/frontdoor/config',
      JSON.stringify({ cmd_t: 'door/set' }), 'b', 1883);
    eq(lock?.kind, 'lock', 'H-4a ★`kind` = `component` **逐字**（庄子·不预设）');
    ok(isHighRiskKind(lock!.kind), 'H-4b ★★`lock` 逐字即命中**既有** `HIGH_RISK_DEVICE_KINDS`（同一把尺 ⇒ 高危写操作自动被闸拒，不另立判据）');
    const sensor = haConfigToDevice('homeassistant/sensor/temp/config',
      JSON.stringify({ stat_t: 'temp/state' }), 'b', 1883);
    eq([sensor?.kind, sensor?.controllable], ['sensor', false], 'H-4c ★纯 `sensor` 无命令主题 ⇒ `controllable=false`（自述无命令即不自称可被命令）');

    // ── H-5 ★`capabilities` 含 `cmd:`/`state:`/`avty:` 前缀（接上传动路的正面断言）──────────
    const full = haConfigToDevice('homeassistant/switch/p2/config',
      JSON.stringify({ uniq_id: 'p2', cmd_t: 'p2/set', stat_t: 'p2/state', avty_t: 'p2/avail' }), 'b', 1883);
    ok(full != null && full.capabilities.includes('mqtt') && full.capabilities.includes('ha:switch')
      && full.capabilities.includes('cmd:p2/set') && full.capabilities.includes('state:p2/state') && full.capabilities.includes('avty:p2/avail'),
      'H-5 ★能力含 `mqtt`/`ha:<component>`/`cmd:`/`state:`/`avty:`（传动路 `mqttCommandTopic` 零改即可认出）', full?.capabilities.join(','));
    eq(full?.address, 'b#p2', 'H-5b 台账地址 = `mqttAddress(brokerHost, unique_id)`（自述身份优先；复用既有地址约定）');
    eq(haConfigToDevice('homeassistant/switch/p3/config', JSON.stringify({ cmd_t: 'p3/set' }), 'b', 1883)?.address,
      'b#switch_p3', 'H-5c ★无 `unique_id` ⇒ 身份**回退** `<component>/<objectId>` 洗成安全段（`switch/p3` ⇒ `switch_p3`）');

    // ── H-6 ★`haCommandPayload` 三语言标本（switch/cover/light+args）+ 反证（认不出⇒逐字回退）──
    eq(haCommandPayload(HA_DEV(['mqtt', 'ha:switch']), 'turn_on', {}), 'ON', 'H-6a switch `turn_on` ⇒ `ON`');
    eq(haCommandPayload(HA_DEV(['mqtt', 'ha:cover']), 'open', {}), 'OPEN', 'H-6b cover `open` ⇒ `OPEN`');
    eq(haCommandPayload(HA_DEV(['mqtt', 'ha:light']), 'turn_on', { brightness_pct: 50 }),
      JSON.stringify({ state: 'ON', brightness_pct: 50 }), 'H-6c ★light 带参数 ⇒ JSON `{"state":"ON", …args}`（HA 标准的带参形）');
    eq(haCommandPayload(HA_DEV(['mqtt', 'ha:light']), 'unknown_action', {}), mqttCommandPayload('unknown_action', {}),
      'H-6d ★★反证：HA 设备上**认不出**的动作 ⇒ **逐字回退**工蚁自有形（如实降级，不阻命令、不乱猜 HA 意图）');
    eq(haCommandPayload(HA_DEV(['mqtt', 'cmd:x/set']), 'turn_on', {}), null,
      'H-6e ★反证：**非 HA 设备**（无 `ha:` 能力）⇒ `null`（由 `deviceCommandPayload` 回退工蚁语言）');

    // ── H-6f 选语言的**一处真源**：`deviceCommandPayload`（HA⇒HA 语言 / 其余⇒工蚁语言）────────
    eq(deviceCommandPayload(HA_DEV(['mqtt', 'ha:switch']), 'turn_off', {}), 'OFF', 'H-6f HA 设备 ⇒ HA 语言（`OFF`）');
    eq(deviceCommandPayload(HA_DEV(['mqtt', 'cmd:x/set']), 'turn_off', {}), mqttCommandPayload('turn_off', {}),
      'H-6g 非 HA 设备 ⇒ 工蚁自有语言（逐字 `{action}`）');

    // ── H-7 ★反证两语言不混：`haConfigToDevice` 对**工蚁自有 JSON 载荷** ⇒ null ─────────────
    eq(haConfigToDevice('workerant/discovery/dev1', JSON.stringify({ id: 'dev1', cmd: 'x/set' }), 'b', 1883), null,
      'H-7 ★★反证：工蚁自有的发现主题/载荷喂给 HA 映射 ⇒ `null`（两语言**互不代劳**，不硬塞）');
    ok(HA_ABBREV.cmd_t === 'command_topic' && HA_ABBREV.avty_t === 'availability_topic',
      'H-7b 缩写表在册（`cmd_t`/`avty_t` 等），非临时硬编');
  }

  // ═══ W｜发现接上 + 传动选语言（批二 · 毛选·集中优势兵力 / 一处真源）══════════════════════════════
  console.log('\n【W】发现接上 + 传动分语言 —— 「一条缝」/「同一段骨」');
  {
    // ── W-1 ★★`mqttDiscoveryIo` 重定向后**行为逐字不变**（订工蚁自有主题、走工蚁自有映射）────────
    {
      const fs1 = makeFakeSub();
      const found: Array<{ name: string }> = [];
      const io = mqttDiscoveryIo({ brokerHost: 'b', io: fs1.io });
      io.start((d) => { found.push({ name: d.name }); });
      eq(fs1.subs.map((s) => s.topic), ['workerant/discovery/#'], 'W-1a ★订阅**工蚁自有**发现主题（缺省 `workerant/discovery/#`）');
      fs1.emit('workerant/discovery/dev1', JSON.stringify({ id: 'dev1', name: '客厅灯', cmd: 'dev1/set' }));
      eq(found.map((f) => f.name), ['客厅灯'], 'W-1b ★★emit 走 `mqttDiscoveryToDevice`（工蚁自有语言）——薄壳重定向后行为逐字不变');
      io.stop();
      ok(fs1.stopped(), 'W-1c 收摊透传到假 io（`stop` 未丢）');
    }

    // ── W-2 ★★`haDiscoveryIo` 订阅 `<prefix>/#` 且 emit 走 `haConfigToDevice`（行为 + 静态）──
    {
      const fs2 = makeFakeSub();
      const found2: Array<{ name: string; kind: string }> = [];
      const io2 = haDiscoveryIo({ brokerHost: 'b', io: fs2.io });
      io2.start((d) => { found2.push({ name: d.name, kind: d.kind }); });
      eq(fs2.subs.map((s) => s.topic), ['homeassistant/#'], 'W-2a ★★订阅 HA 标准树 `<prefix>/#`（缺省 `homeassistant/#`）');
      fs2.emit('homeassistant/switch/plug/config', JSON.stringify({ uniq_id: 'plug', name: '插座', cmd_t: 'plug/set' }));
      eq(found2.map((f) => f.name), ['插座'], 'W-2b ★★emit 走 `haConfigToDevice`（HA 标准语言）');
      // 反证：把工蚁自有主题喂给它 ⇒ 不落（主题范围即"两种语言"的界）
      const n2 = found2.length;
      fs2.emit('workerant/discovery/dev1', JSON.stringify({ id: 'dev1', name: '客厅灯' }));
      eq(found2.length, n2, 'W-2c ★反证：工蚁自有主题喂 HA io ⇒ 不落设备（`haConfigToDevice` 认不出即跳过）');
      io2.stop();
    }
    {
      const src = CODE(`${A}/src/main/core/device-homeassistant.ts`);
      ok(src.includes('handle.subscribe(haDiscoveryTopic(prefix), emit)'),
        'W-2d ★静态：HA io 的订阅主题由**唯一真源** `haDiscoveryTopic(prefix)` 派生（不散写字面量）');
      ok(src.includes('haConfigToDevice(topic, payload, brokerHost, brokerPort, prefix)'),
        'W-2e ★静态：emit 那一跳真调 `haConfigToDevice`（按符号读去注释码）');
    }

    // ── W-3 ★★`resolveHaConfig` 三标本（关/开无 broker⇒false/开有 broker⇒true）─────────────
    eq(resolveHaConfig(() => null), { enabled: false, broker: null, prefix: 'homeassistant' },
      'W-3a ★反证：**不 seed** ⇒ 缺省**关**（"读不到 = 关"，不混 `boolSetting` 那族"缺省即开"）');
    eq(resolveHaConfig((k) => ({ 'device.ha.enabled': '1' } as Record<string, string>)[k]).enabled, false,
      'W-3b ★开着但**无 broker** ⇒ 仍 `false`（缺 broker 的"开"无意义——连不上的开关不算开）');
    const onCfg = resolveHaConfig((k) => ({ 'device.ha.enabled': '1', 'device.mqtt.broker': '192.168.1.9:1883' } as Record<string, string>)[k]);
    eq([onCfg.enabled, onCfg.broker?.host, onCfg.broker?.port], [true, '192.168.1.9', 1883],
      'W-3c ★开 + 有 broker ⇒ `true`，broker 与 MQTT 卡**共用**同一键');
    eq(resolveHaConfig((k) => ({ 'device.ha.prefix': 'ha' } as Record<string, string>)[k]).prefix, 'ha',
      'W-3d ★前缀取自 `device.ha.prefix`（面板可改）');

    // ── W-4 ★`mqttDeviceControl` 语言选路（**注入假 MqttIo 捕获 publish 载荷**）──────────────
    {
      const haPub = makeFakePub();
      await mqttDeviceControl(HA_DEV(['mqtt', 'ha:switch', 'cmd:dev1/set']), 'turn_on', {}, haPub.io);
      eq(haPub.pubs[0]?.payload, 'ON', 'W-4a ★★HA 设备 ⇒ 下发 HA 语言 `ON`（注入探针验真那一跳）');
      eq(haPub.pubs[0]?.topic, 'dev1/set', 'W-4b 主题仍取自 `cmd:` 能力（选语言不改变传动路）');
      const ownPub = makeFakePub();
      await mqttDeviceControl(HA_DEV(['mqtt', 'cmd:dev1/set']), 'turn_on', {}, ownPub.io);
      eq(ownPub.pubs[0]?.payload, mqttCommandPayload('turn_on', {}),
        'W-4c ★★工蚁自有设备 ⇒ 下发工蚁语言（逐字 `{action}`）——同一函数内两语言互不代劳');
    }

    // ── W-5 ★`devices:discover` 三路并联（读去注释码：`parts` 含 `haDiscoveryIo` 且条件同 MQTT 路）─
    {
      const ipc = CODE(`${A}/src/main/ipc/devices.ipc.ts`);
      ok(ipc.includes('parts.push(haDiscoveryIo({') && ipc.includes('if (haCfg.enabled && haCfg.broker)'),
        'W-5a ★★HA 路进 `parts`（`composeDiscoveryIo` 并联），且门条件与 MQTT 路**同形**（`enabled && broker`）');
      ok(ipc.includes('onAvailability: applyAvailability'),
        'W-5b ★静态：可用性回调接进 HA io（在线态的回填入口在这一跳）');
    }
  }

  // ═══ O｜在场：设备在线态（批三 · 道德经·知止不殆）══════════════════════════════════════════════
  console.log('\n【O】设备在线态 —— 「知止不殆」（道德经·四十四章）');
  {
    // ── O-1 ★★`setDeviceOnline` 三态写（**正面 0→1** + 不动 `last_seen` + 不存在⇒null）────────
    {
      const db = mkdb();
      const dev = upsertDiscovered(asDb(db), { name: '灯', kind: 'light', protocol: 'mqtt', address: 'b#d1', port: 1883, capabilities: ['mqtt', 'ha:light'], controllable: true });
      eq(dev.online, null, 'O-1a 刚发现 ⇒ `online=null`（未知——"台账里有它" ≠ "它在线"）');
      const ls0 = dev.last_seen;
      db.prepare('UPDATE wa_devices SET online = 0 WHERE id = ?').run(dev.id);
      eq(getDevice(asDb(db), dev.id)?.online, false, 'O-1b 前置标本：显式置 0（否则"变 1"无从谈起）');
      eq(setDeviceOnline(asDb(db), dev.id, true)?.online, true, 'O-1c ★★正面 **0→1**：写 true 读出 true');
      eq(getDevice(asDb(db), dev.id)?.online, true, 'O-1d 重读仍为 true（真落库）');
      eq(setDeviceOnline(asDb(db), dev.id, false)?.online, false, 'O-1e → false（不在）');
      eq(setDeviceOnline(asDb(db), dev.id, null)?.online, null, 'O-1f → null（未知，三态都能写）');
      eq(setDeviceOnline(asDb(db), 'nope', true), null, 'O-1g 设备不存在 ⇒ `null`（不假装写了）');
      eq(getDevice(asDb(db), dev.id)?.last_seen, ls0, 'O-1h ★★**不动 `last_seen`**——"我们何时见过"（历史）≠"它此刻在不在"（当下）');
    }

    // ── O-2/O-3 ★★可用性回调三标本 + **反证**（discovery 载荷到达**不**置 online）────────────
    {
      const calls: Array<[string, boolean]> = [];
      const fs3 = makeFakeSub();
      const io3 = haDiscoveryIo({ brokerHost: 'b', io: fs3.io, onAvailability: (addr, on) => calls.push([addr, on]) });
      const found3: string[] = [];
      io3.start((d) => found3.push(d.name));
      fs3.emit('homeassistant/switch/plug1/config',
        JSON.stringify({ uniq_id: 'plug1', name: '插座', cmd_t: 'plug1/set', avty_t: 'plug1/avail' }));
      eq(found3, ['插座'], 'O-3a 发现载荷 ⇒ 落一次 `onFound`');
      eq(calls.length, 0, 'O-3b ★★**反证**：discovery 载荷到达 ⇒ **零**可用性回调（绝不从发现载荷推在线——retain 会重放旧值）');
      ok(fs3.subs.some((s) => s.topic === 'plug1/avail'), 'O-2a ★config 自述可用性 ⇒ **动态订阅**其 `avty` 主题（主题须待发现后才知）');
      fs3.emit('plug1/avail', 'online');
      eq(calls.at(-1), ['b#plug1', true], 'O-2b ★可用性载荷 `online` ⇒ 回调 `true`（地址=台账地址 `broker#id`）');
      fs3.emit('plug1/avail', 'offline');
      eq(calls.at(-1), ['b#plug1', false], 'O-2c ★`offline` ⇒ `false`（不在）');
      const nBefore = calls.length;
      fs3.emit('plug1/avail', 'garbage');
      eq(calls.length, nBefore, 'O-2d ★反证：认不出的载荷 ⇒ **不回调**（不写，留旧值——不猜"在线/离线"）');
      // 重复 config ⇒ 不重复订阅
      fs3.emit('homeassistant/switch/plug1/config',
        JSON.stringify({ uniq_id: 'plug1', avty_t: 'plug1/avail' }));
      eq(fs3.subs.filter((s) => s.topic === 'plug1/avail').length, 1, 'O-2e ★重复 config ⇒ 可用性主题**不重复订阅**（去重）');
      io3.stop();
    }

    // ── O-2f 纯助手三标本：`haAvailabilityOnline` 认得出/认不出 ─────────────────────────────
    eq(haAvailabilityOnline('online', { payloadAvailable: 'online', payloadNotAvailable: 'offline' }), true, 'O-2f `payload_available` ⇒ true');
    eq(haAvailabilityOnline('offline', { payloadAvailable: 'online', payloadNotAvailable: 'offline' }), false, 'O-2g `payload_not_available` ⇒ false');
    eq(haAvailabilityOnline('weird', { payloadAvailable: 'online', payloadNotAvailable: 'offline' }), null, 'O-2h ★认不出 ⇒ `null`（调用方据此**不写**）');
    const av = haAvailabilityOf('homeassistant/binary_sensor/m1/config',
      JSON.stringify({ uniq_id: 'm1', avty_t: 'm1/avail', pl_avail: 'ON', pl_not_avail: 'OFF' }), 'b');
    eq([av?.topic, av?.payloadAvailable, av?.payloadNotAvailable, av?.address], ['m1/avail', 'ON', 'OFF', 'b#m1'],
      'O-2i ★自述载荷（`pl_avail`/`pl_not_avail`）优先于缺省 `online`/`offline`；地址算法与 `haConfigToDevice` 同');
    eq(haAvailabilityOf('homeassistant/switch/noavail/config', JSON.stringify({ cmd_t: 'x/set' }), 'b'), null,
      'O-2j ★无可用性自述 ⇒ `null`（在线态留未知，不猜）');

    // ── O-4 ★`rowToDevice` 三态投影（未给值⇒null；0⇒false；1⇒true）────────────────────────
    {
      const db = mkdb();
      db.prepare("INSERT INTO wa_devices (id, name, protocol, address) VALUES ('x1','旧设备','mqtt','b#x1')").run();
      eq(getDevice(asDb(db), 'x1')?.online, null, 'O-4a ★未给 `online` 值 ⇒ 读出 `null`（未知），不把"未知"读成"不在"');
      db.prepare("INSERT INTO wa_devices (id, name, protocol, address, online) VALUES ('x2','关','mqtt','b#x2',0)").run();
      eq(getDevice(asDb(db), 'x2')?.online, false, 'O-4b `online=0` ⇒ `false`（不在）');
      db.prepare("INSERT INTO wa_devices (id, name, protocol, address, online) VALUES ('x3','开','mqtt','b#x3',1)").run();
      eq(getDevice(asDb(db), 'x3')?.online, true, 'O-4c `online=1` ⇒ `true`（在）');
      eq(findDeviceByIdentity(asDb(db), 'mqtt', 'b#x3')?.online, true, 'O-4d 去重键取行（`findDeviceByIdentity`）同样投影三态');
    }

    // ── O-5 ★DDL / 迁移含 `online`（老库自动补列 ⇒ 向后兼容的真载体）────────────────────────
    {
      const dbts = RD(`${A}/src/main/database.ts`);
      ok(/CREATE TABLE IF NOT EXISTS wa_devices \([\s\S]{0,600}?online INTEGER/.test(dbts),
        'O-5a ★建表含 `online INTEGER`（新库）');
      ok(/ALTER TABLE wa_devices ADD COLUMN online INTEGER/.test(dbts),
        'O-5b ★★迁移块含 `ALTER TABLE wa_devices ADD COLUMN online`（老生产库自动补列——后向兼容的**真载体**）');
    }
  }

  // ═══ G｜GUI（批四 · 承 `feedback_promised_toggle_needs_gui_io`）═══════════════════════════════
  console.log('\n【G】GUI 读写口 —— 「承诺了开关，就得点得到」（按用户可达动作反查）');
  {
    const page = CODE(`${A}/renderer/src/pages/DevicesPage.tsx`);
    // ── G-1 ★HA 两键**逐键**经设置口写（与 MQTT 卡同一通道）────────────────────────────────
    ok(page.includes("invoke('settings:set', 'device.ha.enabled'"), 'G-1a ★`device.ha.enabled` 经 `settings:set` 落盘（点得到）');
    ok(page.includes("invoke('settings:set', 'device.ha.prefix'"), 'G-1b ★`device.ha.prefix` 经 `settings:set` 落盘（点得到）');
    ok(page.includes("invoke('settings:set', 'device.mqtt.enabled'"), 'G-1c 反证对照：同卡 MQTT 键亦经同一通道（不是只登记白名单却点不到）');
    ok(page.includes('devicesApi.mqttStatus()'), 'G-1d 界面取态走**如实回包** `devices:mqtt_status`（不自写判据）');

    // ── G-2 ★在线三态字面量逐成员枚举 ──────────────────────────────────────────────────────
    ok(page.includes('online === true ?') && page.includes('online === false ?'),
      'G-2a ★`OnlineBadge` 三分支穷举（`=== true` / `=== false` / 其余=未知）');
    ok(page.includes("'在'") && page.includes("'不在'") && page.includes("'未知'"),
      'G-2b ★三态字面量逐成员在册（在/不在/未知）');

    // ── G-3 ★反证：徽章**不**以 `last_seen` 渲染"在线" ─────────────────────────────────────
    ok(page.includes('<OnlineBadge online={dev.online} />'), 'G-3a ★徽章**只**读 `dev.online`');
    ok(!/<OnlineBadge[^>]*last_seen/.test(page), 'G-3b ★★反证：徽章**不**以 `last_seen` 渲染在线（两件事各写各的列）');
    ok(page.includes('最近见到') && page.includes('dev.last_seen'),
      'G-3c ★`last_seen` 另起一行印「最近见到」（与在线态分开，不混作一件事）');
  }

  // ═══ V｜第三方真实载荷回放（形状来自第三方，仍零硬件）══════════════════════════════════════════
  console.log('\n【V】第三方真实载荷回放 —— 「回别人的声音，才知自己听得对不对」');
  {
    // 本组标本**取自第三方**（非自造）——目的：拿**别人产生**的 discovery 形状喂生产码，
    // 照出"只按自造标本想当然"照不出的键/嵌套/写法（自造标本只会含我们想到的东西）。
    // 来源（逐条标注在断言旁）：
    //   ① HA MQTT 集成文档 <https://www.home-assistant.io/integrations/mqtt/>（缩写表 / 主题形 / `~` 例）
    //   ② Zigbee2MQTT —— `Koenkk/zigbee2mqtt` issue #18884 / #21616 调试日志里的原样载荷
    //   ③ Tasmota 遗留发现（`SetOption19`）—— `eclipse-archived/smarthome#6749` / HA 社区原样载荷
    //   ④ HA MQTT discovery 蒸馏参考 <https://github.com/electrification-bus/python-sdk/blob/main/doc/ha-mqtt-discovery.md>
    // ⚠ 逐字者标 [逐字]；缺失处按文档所述形状重建者标 [重建] 并写明依据。

    // ── V-1 ★★★Tasmota switch（来源③ [逐字]）——照出缩写表把 `stat_on` 误映 `payload_on`、漏 `pl_on`/`pl_off` ──
    const tsw = haConfigToDevice('homeassistant/switch/45D1FA_RL_1/config',
      `{"name":"Sonoff_Garage","cmd_t":"~cmnd/POWER","stat_t":"~tele/STATE","val_tpl":"{{value_json.POWER}}","pl_off":"OFF","pl_on":"ON","avty_t":"~tele/LWT","pl_avail":"Online","pl_not_avail":"Offline","uniq_id":"45D1FA_RL_1","device":{"identifiers":["45D1FA"],"name":"Sonoff_Garage","model":"1 Channel","sw_version":"6.4.1(sonoff)","manufacturer":"Tasmota"}, "~":"sonoff/sonoff_garage/"}`,
      'b', 1883);
    ok(tsw != null && tsw.kind === 'switch' && tsw.controllable === true && tsw.name === 'Sonoff_Garage',
      'V-1a Tasmota switch 认得出（kind/name/controllable；全称与缩写混用）', tsw?.kind + '/' + tsw?.name);
    eq(tsw?.address, 'b#45D1FA_RL_1', 'V-1b 身份取自述 `uniq_id`');
    ok(tsw != null && tsw.capabilities.includes('cmd:sonoff/sonoff_garage/cmnd/POWER')
      && tsw.capabilities.includes('state:sonoff/sonoff_garage/tele/STATE')
      && tsw.capabilities.includes('avty:sonoff/sonoff_garage/tele/LWT'),
      'V-1c ★`~` 基主题**末尾带 `/`** 也正确展开进三能力（Tasmota 常见写法）', tsw?.capabilities.join(','));
    ok(tsw != null && tsw.capabilities.includes('on:ON') && tsw.capabilities.includes('off:OFF'),
      'V-1d ★★★`pl_on`/`pl_off`（HA 标准缩写）⇒ `on:`/`off:` 能力（自述开/关载荷**真被读到**）', tsw?.capabilities.join(','));
    // 承重点断言：自述载荷**非** ON/OFF 时下行须按自述发——证明 V-1d 不是"恰好等于缺省"而蒙对。
    const pulse = haConfigToDevice('homeassistant/switch/pulse/config',
      `{"name":"脉冲","cmd_t":"pulse/cmnd/POWER","pl_on":"1","pl_off":"0","uniq_id":"pulse1"}`, 'b', 1883);
    eq(pulse ? haCommandPayload(pulse, 'turn_on', {}) : null, '1',
      'V-1e ★★★自述 `pl_on:"1"` ⇒ 下行发 **`1`**（**非** HA 缺省 `ON`）——自述真被消费，非蒙对');
    eq(pulse ? haCommandPayload(pulse, 'turn_off', {}) : null, '0', 'V-1f ★`pl_off:"0"` ⇒ 下行发 `0`');
    // ★反证：`stat_on`/`stat_off` 是 `state_on`/`state_off`（**状态**语义），**不是**命令载荷。
    const so = haConfigToDevice('homeassistant/switch/so/config',
      `{"name":"S","stat_t":"s/state","stat_on":"ON","stat_off":"OFF","uniq_id":"s1"}`, 'b', 1883);
    ok(so != null && !so.capabilities.some((c) => c.startsWith('on:') || c.startsWith('off:')),
      'V-1g ★反证：`stat_on`/`stat_off`（状态语义）⇒ **不**产生 `on:`/`off:` 命令能力（两回事，不混）', so?.capabilities.join(','));
    eq(HA_ABBREV.pl_on, 'payload_on', 'V-1h ★对照真源：`pl_on`→`payload_on`（来源① 缩写表）');
    eq(HA_ABBREV.stat_on, 'state_on', 'V-1i ★缩写表 `stat_on`→`state_on`（旧表误映 `payload_on`——本轮订正）');

    // ── V-2 ★★Zigbee2MQTT 灯（来源② [逐字]）——**全称键** + `availability` **数组**（非 `availability_topic`）──
    const Z2M_LIGHT_TOPIC = 'homeassistant/light/0x0017880102bd4d3c/light/config';
    const Z2M_LIGHT = `{"availability":[{"topic":"zigbee2mqtt/bridge/state","value_template":"{{ value_json.state }}"},{"topic":"zigbee2mqtt/0x0017880102bd4d3c/availability","value_template":"{{ value_json.state }}"}],"availability_mode":"all","command_topic":"zigbee2mqtt/Bedroom Bed back light/set","device":{"identifiers":["zigbee2mqtt_0x0017880102bd4d3c"],"manufacturer":"Philips","model":"Hue white A60 bulb E27 (9290011370)","name":"Bedroom Bed back light","sw_version":"Zigbee2MQTT 1.17.0"},"brightness":true,"brightness_scale":254,"effect":true,"effect_list":["blink","breathe","okay","channel_change","finish_effect","stop_effect"],"name":"Bedroom Bed back light","schema":"json","state_topic":"zigbee2mqtt/Bedroom Bed back light","unique_id":"0x0017880102bd4d3c_light_zigbee2mqtt"}`;
    const z2m = haConfigToDevice(Z2M_LIGHT_TOPIC, Z2M_LIGHT, 'b', 1883);
    ok(z2m != null && z2m.kind === 'light' && z2m.controllable === true, 'V-2a Z2M light 认得出（kind/controllable）');
    eq(z2m?.name, 'Bedroom Bed back light', 'V-2b 名字取顶层 `name`');
    eq(z2m?.address, 'b#0x0017880102bd4d3c_light_zigbee2mqtt', 'V-2c 身份取 `unique_id`（下划线原样保留）');
    ok(z2m != null && z2m.capabilities.includes('cmd:zigbee2mqtt/Bedroom Bed back light/set')
      && z2m.capabilities.includes('state:zigbee2mqtt/Bedroom Bed back light'),
      'V-2d ★Z2M 用**全称键**（`command_topic`/`state_topic`）——同样认（来源①：全称与缩写并存）', z2m?.capabilities.join(','));
    ok(z2m != null && !z2m.capabilities.some((c) => c.startsWith('avty:')),
      'V-2e ★登记边界：Z2M 用 `availability` **数组**，而 `haConfigToDevice` 只读 `availability_topic` ⇒ **无** `avty:` 能力（该前缀今无消费方；多源聚合见 §四.5）');
    const z2mAv = haAvailabilityOf(Z2M_LIGHT_TOPIC, Z2M_LIGHT, 'b');
    eq(z2mAv?.address, 'b#0x0017880102bd4d3c_light_zigbee2mqtt',
      'V-2f ★可用性路（批三）读 `availability[0].topic`；地址与 `haConfigToDevice` **同算法**（同一把尺）');
    eq(z2mAv?.topic, 'zigbee2mqtt/bridge/state',
      'V-2g ★登记边界：本轮取**首个**源（Z2M 的 [0] 是**桥**主题）——`availability_mode:all` 多源聚合登记待判（§四.5）');

    // ── V-3 ★只读传感器（来源① [重建]：依 HA 文档 sensor 字段 `stat_t`+`val_tpl`，无 `cmd_t`）────────
    const sen = haConfigToDevice('homeassistant/sensor/room_temperature/config',
      `{"name":"Room Temperature","uniq_id":"dev123_temp","stat_t":"mydevice/room/temperature","unit_of_meas":"°C","dev_cla":"temperature","val_tpl":"{{ value_json.temperature }}","device":{"ids":["dev123"],"name":"My Device","mf":"YourCompany","mdl":"ESP32"}}`,
      'b', 1883);
    eq([sen?.kind, sen?.controllable], ['sensor', false],
      'V-3a ★只读 sensor ⇒ `controllable=false`（无 `cmd_t` ⇒ 不自称可被命令）');
    ok(sen != null && sen.capabilities.includes('state:mydevice/room/temperature')
      && !sen.capabilities.some((c) => c.startsWith('cmd:')),
      'V-3b ★缩写键（`uniq_id`/`stat_t`/`unit_of_meas`/`dev_cla`/`val_tpl`）逐条展开；无 `cmd:` 能力', sen?.capabilities.join(','));
    eq(sen?.address, 'b#dev123_temp', 'V-3c 身份取 `uniq_id`');
    eq(sen?.name, 'Room Temperature', 'V-3d 名字取顶层 `name`（非 `device.name`）');

    // ── V-4 ★HA **设备级**发现形（来源④ [逐字]）——`homeassistant/device/<id>/config` + `dev`/`o`/`cmps` ──
    const dv = haConfigToDevice('homeassistant/device/kitchen/config',
      `{"dev":{"ids":"ea334450945afc","name":"Kitchen","mf":"Bla electronics","mdl":"xya","sw":"1.0","sn":"ea334450945afc","hw":"1.0rev2"},"o":{"name":"bla2mqtt","sw":"2.1","url":"https://bla2mqtt.example.com/support"},"cmps":{"some_unique_component_id1":{"p":"sensor","device_class":"temperature","unit_of_measurement":"°C","value_template":"{{ value_json.temperature }}","unique_id":"temp01ae_t"},"some_unique_id2":{"p":"sensor","device_class":"humidity","unit_of_measurement":"%","value_template":"{{ value_json.humidity }}","unique_id":"temp01ae_h"}},"state_topic":"sensorBedroom/state","qos":2}`,
      'b', 1883);
    ok(dv != null && dv.name === 'Kitchen' && dv.controllable === false,
      'V-4a ★设备级发现形**认得出**（读成**一台**设备；名字取自 `dev.name`）');
    ok(dv != null && dv.capabilities.includes('state:sensorBedroom/state'), 'V-4b ★顶层 `state_topic` 进 `state:` 能力');
    ok(dv != null && !dv.capabilities.some((c) => c.startsWith('ha:sensor')),
      'V-4c ★登记边界：**不展开** `cmps` 组件（多组件共享一 `state_topic`）——当前读成**一台**设备（组件级展开登记待判）');
  }

  // ═══ S｜自指 + build 钉（G-6 派生核对）═══════════════════════════════════════════════════════
  console.log('\n【S】自指 + 哑雷自检 + build 钉（派生核对）');
  {
    const selfLines = stripKeepingLines(RD(`scripts/${path.basename(__filename)}`)).join('\n');
    const selfPins = [...selfLines.matchAll(/(?<![A-Za-z0-9_])(?:build:\s*|ROUND\s*=\s*|includes\()'(zx_[0-9_]+)'/g)];
    ok(selfPins.length === 0, 'S-1 ★本文件零 build 轮次字面量（G-6：不写"只为下一轮"的哑雷）', selfPins.map((m) => m[1]).join(',') || '0 处');
    ok(/zx_\d{8}/.test(SELF_ROUND) && fs.existsSync(path.join(root, `plans/improve/${SELF_ROUND}.md`)),
      'S-2 ★方向性自指（由载体自身派生）：本轮方案文件在场', `plans/improve/${SELF_ROUND}.md`);
    ok(fs.existsSync(path.join(root, `scripts/rr_${SELF_ROUND}.ts`)),
      'S-3 本套件在册（脚本名由载体派生）', `scripts/rr_${SELF_ROUND}.ts`);

    checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });
  }
}

// ⚠ `catch` 不可省：夹具/断言抛异常时若只挂 `finally`，`process.exit` 会在 Node 报告 unhandled
//   rejection **之前**把进程带走 ⇒ 跑到一半崩掉的复跑会打出一行 ✅ 假绿。
(async () => {
  try {
    await main();
    console.log(`\n${fail === 0 ? '✅' : '❌'} rr_zx_20261015_3: ${pass} 通过 / ${fail} 失败\n`);
    process.exit(fail === 0 ? 0 : 1);
  } catch (e: unknown) {
    console.error('\n💥 rr_zx_20261015_3 未捕获异常（复跑**未跑完**，不得读作通过）：', e);
    fail++;
    console.log(`\n❌ rr_zx_20261015_3: ${pass} 通过 / ${fail} 失败\n`);
    process.exit(1);
  }
})();
