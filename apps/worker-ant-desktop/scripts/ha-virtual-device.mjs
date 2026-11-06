#!/usr/bin/env node
/**
 * ha-virtual-device.mjs —— **合成标本**（synthetic specimen）。
 *
 * 目的：在没有 Zigbee 协调器 / 真实智能设备的前提下，把工蚁的
 *       「HA 标准桥」整条管道走通：
 *         discovery 上行 → 落账 → 授权 → 下行命令 → 留痕 → 在线三态。
 *
 * ⚠ 诚实标注：这不是真实品牌设备。它**验证的是结构性端到端**
 *   （主题形状 / 载荷语言 / 可用性事件），**不**代表任何真实设备
 *   的怪癖（每家实现在 HA 标准之外都可能有自己的加料）。
 *   真机 E2E 仍须 Zigbee 协调器 + Zigbee2MQTT（见方案 §四.1）。
 *
 * 它发的每一份 discovery config 都**严格照 HA 标准**：
 *   · 主题形态 `<prefix>/<component>/[<node_id>/]<object_id>/config`
 *   · 保留发布（retain）——HA 与工蚁都靠保留载荷在订阅瞬间即拿到
 *   · 缩写键（`uniq_id`/`cmd_t`/`avty_t`/`~`）与全称键**各半**，
 *     以覆盖工蚁 `normalizeHaKeys` 的两条路
 *
 * 用法：
 *   node apps/worker-ant-desktop/scripts/ha-virtual-device.mjs up      # 发布 + 在线 + 应答命令（常驻）
 *   node apps/worker-ant-desktop/scripts/ha-virtual-device.mjs down    # 只发「离线」（保留），退出
 *   node apps/worker-ant-desktop/scripts/ha-virtual-device.mjs clean   # 清空保留载荷（发现 + 可用性）
 *   node apps/worker-ant-desktop/scripts/ha-virtual-device.mjs list    # 只打印清单，不连网
 *
 * 环境变量：
 *   HA_BROKER  broker 地址（缺省 mqtt://127.0.0.1:1883）
 *   HA_PREFIX  discovery 前缀（缺省 homeassistant）
 *   HA_VERBOSE=1 打印每条收发
 *
 * ⚠ broker 须是**本机**（回环）。工蚁侧的 SSRF 围栏（`isLanAddress`）拒主机名
 *   `localhost` —— 在工蚁面板里填 `127.0.0.1:1883`，不是 `localhost:1883`。
 */
import mqtt from 'mqtt';

const BROKER = process.env.HA_BROKER || 'mqtt://127.0.0.1:1883';
const PREFIX = (process.env.HA_PREFIX || 'homeassistant').replace(/^\/+|\/+$/g, '');
const VERBOSE = process.env.HA_VERBOSE === '1';

const log = (...a) => console.log('[sim]', ...a);
const vlog = (...a) => { if (VERBOSE) console.log('[sim·v]', ...a); };

// ───────────────────────── 设备清单 ─────────────────────────
//
// 五台，刻意覆盖五种形状：
//   ① switch  —— 全称键、无 `~`、3 段主题（无 node_id）
//   ② light   —— 缩写键 + `~` 基主题、4 段主题（有 node_id）、
//                且**无顶层 name** ⇒ 名字只能取自 `device` 块（覆盖回退路）
//   ③ cover   —— 缩写键、OPEN/CLOSE/STOP 语言
//   ④ sensor  —— **无 cmd_t** ⇒ 工蚁判 `controllable:false`（只读）
//   ⑤ lock    —— 工蚁高危名单逐字命中 ⇒ 即便授权也拒写（K-6 闸）

/** @param {string} id */
const availTopic = (id) => `wa_sim/${id}/availability`;
/** @param {string} id */
const stateTopic = (id) => `wa_sim/${id}/state`;
/** @param {string} id */
const cmdTopic = (id) => `wa_sim/${id}/set`;

const DEVICES = [
  {
    key: 'switch_1',
    component: 'switch',
    nodeId: null,             // 3 段主题：homeassistant/switch/<objectId>/config
    objectId: 'wa_sim_switch_1',
    uniqueId: 'wa_sim_switch_1',
    name: '客厅台灯',
    /** 全称键（与缩写键各半，覆盖 normalizeHaKeys 两条路） */
    config: () => ({
      name: '客厅台灯',
      unique_id: 'wa_sim_switch_1',
      command_topic: cmdTopic('switch_1'),
      state_topic: stateTopic('switch_1'),
      availability_topic: availTopic('switch_1'),
      payload_available: 'online',
      payload_not_available: 'offline',
      payload_on: 'ON',
      payload_off: 'OFF',
      device: { identifiers: ['wa_sim_switch_1'], name: '客厅台灯', model: 'WA-SIM', manufacturer: 'worker-ant simulator' },
    }),
    // 初始状态（发布到 stat_t，让面板一开始就看到非空态）
    state: 'OFF',
    /** 命令载荷 → 新状态 */
    react(payload, cur) {
      if (payload === 'TOGGLE') return cur === 'ON' ? 'OFF' : 'ON';
      return payload;
    },
  },
  {
    key: 'light_strip',
    component: 'light',
    nodeId: 'wa_sim',         // 4 段主题：homeassistant/light/wa_sim/<objectId>/config
    objectId: 'light_strip',
    uniqueId: 'wa_sim_light_strip',
    name: null,               // 刻意不设 ⇒ 名字取自 device 块
    /** 缩写键 + `~` 基主题 */
    config: () => ({
      '~': `wa_sim/light_strip`,
      uniq_id: 'wa_sim_light_strip',
      cmd_t: '~/set',
      stat_t: '~/state',
      avty_t: '~/availability',
      pl_avail: 'online',
      pl_not_avail: 'offline',
      dev: { identifiers: ['wa_sim_light_strip'], name: '卧室灯带', model: 'WA-SIM', manufacturer: 'worker-ant simulator' },
    }),
    state: '{"state":"OFF","brightness":0}',
    react(payload, cur) {
      // 带参命令是 JSON `{"state":"ON","brightness":128}`（工蚁 haCommandPayload 的 withArgs 形）；
      // 裸命令是字面量 `ON`/`OFF`/`TOGGLE`。**两种都收**——真 HA 灯的状态一律是 JSON，
      // 裸命令也须折进 JSON 而不是把状态形丢掉（否则面板上的状态形状会随命令形而变）。
      let obj = null;
      try { const p = JSON.parse(payload); if (p && typeof p === 'object') obj = p; } catch { /* 字面量 */ }
      const prev = (() => { try { return JSON.parse(cur); } catch { return {}; } })();
      const next = { ...prev, ...(obj ?? { state: payload }) };
      if (next.state === 'TOGGLE') next.state = prev.state === 'ON' ? 'OFF' : 'ON';
      // 开而没给亮度 ⇒ 补个默认（`0` 也算"没给"——关灯时清零的痕迹，不是用户要的亮度）。
      if (next.state === 'ON' && !next.brightness) next.brightness = 200;
      if (next.state === 'OFF') next.brightness = 0;
      return JSON.stringify(next);
    },
  },
  {
    key: 'cover_1',
    component: 'cover',
    nodeId: null,
    objectId: 'wa_sim_cover_1',
    uniqueId: 'wa_sim_cover_1',
    name: '车库卷帘门',
    config: () => ({
      uniq_id: 'wa_sim_cover_1',
      name: '车库卷帘门',
      cmd_t: cmdTopic('cover_1'),
      stat_t: stateTopic('cover_1'),
      avty_t: availTopic('cover_1'),
      dev_cla: 'garage',
      dev: { identifiers: ['wa_sim_cover_1'], name: '车库卷帘门', model: 'WA-SIM', manufacturer: 'worker-ant simulator' },
    }),
    state: 'CLOSED',
    react(payload) {
      if (payload === 'OPEN') return 'OPEN';
      if (payload === 'CLOSE') return 'CLOSED';
      if (payload === 'STOP') return 'STOPPED';
      return payload;
    },
  },
  {
    key: 'sensor_1',
    component: 'sensor',
    nodeId: null,
    objectId: 'wa_sim_sensor_1',
    uniqueId: 'wa_sim_sensor_1',
    name: '客厅温度计',
    /** **无 cmd_t** ⇒ 工蚁判不可控（只读设备） */
    config: () => ({
      uniq_id: 'wa_sim_sensor_1',
      name: '客厅温度计',
      stat_t: stateTopic('sensor_1'),
      avty_t: availTopic('sensor_1'),
      unit_of_meas: '°C',
      dev_cla: 'temperature',
      stat_cla: 'measurement',
      dev: { identifiers: ['wa_sim_sensor_1'], name: '客厅温度计', model: 'WA-SIM', manufacturer: 'worker-ant simulator' },
    }),
    state: '24.5',
    controllable: false,
    react: null,
  },
  {
    key: 'lock_1',
    component: 'lock',
    nodeId: null,
    objectId: 'wa_sim_lock_1',
    uniqueId: 'wa_sim_lock_1',
    name: '前门智能锁',
    /** kind 逐字 `lock` ⇒ 命中工蚁 HIGH_RISK_DEVICE_KINDS（K-6 闸：即便授权也拒写） */
    config: () => ({
      uniq_id: 'wa_sim_lock_1',
      name: '前门智能锁',
      cmd_t: cmdTopic('lock_1'),
      stat_t: stateTopic('lock_1'),
      avty_t: availTopic('lock_1'),
      dev: { identifiers: ['wa_sim_lock_1'], name: '前门智能锁', model: 'WA-SIM', manufacturer: 'worker-ant simulator' },
    }),
    state: 'LOCKED',
    react(payload) {
      const s = String(payload);
      if (s === 'LOCK') return 'LOCKED';
      if (s === 'UNLOCK') return 'UNLOCKED';
      let obj = null;
      try { obj = JSON.parse(s); } catch { /* 字面量 */ }
      if (obj && typeof obj === 'object') {
        const a = String(obj.action ?? '');
        if (a.includes('lock') && !a.includes('unlock')) return 'LOCKED';
        if (a.includes('unlock')) return 'UNLOCKED';
      }
      return s;
    },
  },
];

/** discovery 主题（HA 标准：`<prefix>/<component>/[<node_id>/]<object_id>/config`）。 */
function discoveryTopicFor(d) {
  const mid = d.nodeId ? `${d.nodeId}/` : '';
  return `${PREFIX}/${d.component}/${mid}${d.objectId}/config`;
}

function printList() {
  log(`broker  ${BROKER}`);
  log(`prefix  ${PREFIX}`);
  log('设备清单：');
  for (const d of DEVICES) {
    const dt = discoveryTopicFor(d);
    const cmd = d.controllable === false ? '（只读·无 cmd_t）' : cmdTopic(d.key);
    log(`  · ${d.component.padEnd(9)} ${String(d.name ?? '(名字取自 device 块)').padEnd(12)} id=${d.uniqueId}`);
    log(`      discovery ${dt}`);
    log(`      cmd       ${cmd}`);
    log(`      state     ${stateTopic(d.key)}`);
    log(`      avail     ${availTopic(d.key)}`);
  }
}

// ───────────────────────── 连接与发布 ─────────────────────────

function connect() {
  return new Promise((resolve, reject) => {
    const c = mqtt.connect(BROKER, {
      clientId: `wa-sim-${process.pid}-${Math.random().toString(16).slice(2, 8)}`,
      connectTimeout: 5000,
      reconnectPeriod: 0,
      // ⚠ 刻意**不设** LWT：MQTT 每个连接只有**一份**遗嘱，而本进程代表 5 台设备。
      //   一份遗嘱只能覆盖其中一台（会使另外四台的在线态假「离线」）。真正的逐设备 LWT
      //   须每台设备一个 MQTT 连接——与工蚁侧「自有设备 LWT」同一件待做未做的事（方案 §四.2）。
      //   本模拟器用**主动 down** + SIGINT 收摊（计划内退出）表达离线；非计划退出（kill -9）
      //   此脚本**表达不了**，如实说明，不假装。
    });
    c.once('connect', () => resolve(c));
    c.once('error', reject);
  });
}

/** 逐设备发可用性（retained：订阅方**连上即可知**在不在）。 */
function publishAvailability(client, online) {
  return Promise.all(DEVICES.map((d) => new Promise((resolve) => {
    client.publish(availTopic(d.key), online ? 'online' : 'offline', { qos: 1, retain: true }, () => resolve());
  })));
}

/** 保留发布 discovery config。 */
function publishDiscovery(client) {
  return Promise.all(DEVICES.map((d) => new Promise((resolve) => {
    const topic = discoveryTopicFor(d);
    const payload = JSON.stringify(d.config());
    vlog(`retain  ${topic}  ${payload}`);
    client.publish(topic, payload, { qos: 1, retain: true }, () => resolve());
  })));
}

/** 发布状态（stat_t）。
 *  ⚠ **不保留**：保留状态会在 worker-ant 订阅的**瞬间**先送达旧值，
 *    使「设备回执」显示上一次的状态而不是本次命令的结果。真 HA 设备多保留状态——
 *    此处为让端到端回执**如实反映本次命令**而不保留；这是演示取舍，不是标准要求。 */
function publishState(client, d, state) {
  return new Promise((resolve) => {
    client.publish(stateTopic(d.key), state, { qos: 1, retain: false }, () => resolve());
  });
}

/** 清空保留载荷（发现 + 可用性 + 状态）。 */
function clearRetained(client) {
  return Promise.all(DEVICES.flatMap((d) => [
    new Promise((r) => client.publish(discoveryTopicFor(d), '', { qos: 1, retain: true }, () => r())),
    new Promise((r) => client.publish(availTopic(d.key), '', { qos: 1, retain: true }, () => r())),
    new Promise((r) => client.publish(stateTopic(d.key), '', { qos: 1, retain: true }, () => r())),
  ]));
}

// ───────────────────────── 子命令 ─────────────────────────

async function main() {
  const mode = (process.argv[2] || 'up').toLowerCase();

  if (mode === 'help' || mode === '-h' || mode === '--help') {
    printList();
    console.log('\n用法： up | down | clean | list');
    return;
  }
  if (mode === 'list') { printList(); return; }

  if (mode === 'down') {
    const client = await connect();
    await publishAvailability(client, false);
    log('已发「离线」（retained）——工蚁面板应从「在线」转为「离线」。');
    await new Promise((r) => client.end(false, {}, r));
    return;
  }

  if (mode === 'clean') {
    const client = await connect();
    await clearRetained(client);
    log('已清空本模拟器的全部保留载荷（发现 / 可用性 / 状态）。');
    await new Promise((r) => client.end(false, {}, r));
    return;
  }

  if (mode !== 'up') {
    console.error(`[sim] 未知子命令：${mode}（可用：up | down | clean | list）`);
    process.exit(2);
  }

  // ── up：发布 → 在线 → 应答命令（常驻）──
  const client = await connect();
  log(`已连上 ${BROKER}`);

  await publishDiscovery(client);
  log(`已保留发布 ${DEVICES.length} 份 discovery config（${PREFIX}/#）`);

  await publishAvailability(client, true);
  log('已发布「在线」（retained）');

  // 初始状态也发一遍（让面板首屏就看到非空态）
  for (const d of DEVICES) await publishState(client, d, d.state);

  // 订阅每台**可控**设备的命令主题并应答
  for (const d of DEVICES) {
    if (d.controllable === false) continue;
    const topic = cmdTopic(d.key);
    client.subscribe(topic, { qos: 1 }, () => vlog(`subscribed ${topic}`));
  }

  client.on('message', async (topic, buf) => {
    const payload = String(buf ?? '');
    const d = DEVICES.find((x) => x.controllable !== false && cmdTopic(x.key) === topic);
    if (!d) { vlog(`(忽略) ${topic} = ${payload}`); return; }
    let next;
    try {
      next = d.react(payload, d.state);
    } catch (e) {
      next = `ERROR:${e.message}`;
    }
    d.state = next;
    log(`← ${d.name ?? d.key}（${d.component}）收到 ${JSON.stringify(payload)} ⇒ 回状态 ${JSON.stringify(next)}`);
    await publishState(client, d, next);
  });

  // 温度计：每 30s 抖一个值（演示只读设备的持续上报）
  const sensor = DEVICES.find((d) => d.component === 'sensor');
  if (sensor) {
    setInterval(async () => {
      const v = (22 + Math.random() * 4).toFixed(1);
      sensor.state = v;
      await publishState(client, sensor, v);
      vlog(`sensor tick ${v}`);
    }, 30_000).unref?.();
  }

  printList();
  log('');
  log('模拟器常驻中（Ctrl-C 退出）。退出时会自动发「离线」。');
  log('提示：另开终端跑 `... down` 可主动置离线，`... up` 可再置在线。');

  const bye = async () => {
    log('收摊：发「离线」…');
    try { await publishAvailability(client, false); } catch { /* 收摊噪声 */ }
    client.end(true, () => process.exit(0));
    setTimeout(() => process.exit(0), 800).unref?.();
  };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}

main().catch((e) => {
  console.error('[sim] 失败：', e?.message || e);
  console.error(`[sim] 检查 broker 是否可达：${BROKER}`);
  console.error('[sim] 本机 mosquitto： /opt/homebrew/opt/mosquitto/sbin/mosquitto -c /opt/homebrew/etc/mosquitto/mosquitto.conf -d');
  process.exit(1);
});
