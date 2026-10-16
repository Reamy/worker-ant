/**
 * mqtt-d1d2-e2e.ts —— **MQTT 控制面三病端到端核验**（真连 broker，真跑生产函数）。
 *
 * 承 `zx_20261016_1` 批一（D1 假回执 / D2 订阅泄漏 / D3 连接不关停），`zx_20261015_3` §四.8 登记。
 *
 * 与 rr / ha-sim-e2e.ts 的分工同前：
 *   · rr 是受控回归——零外部依赖、假 IO、注入时钟。
 *   · ha-sim-e2e.ts 验 HA 桥（发现→落账→在线→控制）。
 *   · 本脚本验**控制路径自身的三处病灶**，必须有活 broker；故**刻意不进 rr 套件**。
 *
 * 跑的是**生产码原样**：`mqttDeviceControl` → `defaultMqttIo` → `publishAndAwaitState`
 *   （含模块级连接缓存 `clients` 与订阅引用计数 `stateSubRefs`，不另写一份判据版）。
 *
 * ⚠ **零数据库**：设备对象全在内存里现造，只借 broker 走一次真往返。
 *
 * 前置（缺一即 SKIP，退出码 0——"环境没搭"不是"代码坏了"）：
 *   本机 broker 在 `HA_BROKER`（缺省 `mqtt://127.0.0.1:1883`）
 *   模拟器在线：`node apps/worker-ant-desktop/scripts/ha-virtual-device.mjs up`（阳性对照/幽灵用）
 *
 * 用法：
 *   ./node_modules/.bin/tsx apps/worker-ant-desktop/scripts/mqtt-d1d2-e2e.ts           # D1 + D2
 *   ./node_modules/.bin/tsx apps/worker-ant-desktop/scripts/mqtt-d1d2-e2e.ts --probe   # 只读 $SYS 两值（D3 前后各读一次）
 */
import mqtt from 'mqtt';
import { mqttAddress, mqttDeviceControl } from '../src/main/core/device-mqtt.js';
import type { AnsDevice } from '../src/main/core/device-registry.js';

const BROKER_URL = process.env.HA_BROKER || 'mqtt://127.0.0.1:1883';
const HOST = '127.0.0.1';
const PORT = 1883;

/** mosquitto `$SYS` 的发布间隔缺省 10s ⇒ 读值前须**静置过一轮**，否则读到的是上一轮的值。 */
const SYS_SETTLE_MS = 11_000;

const SYS_SUBS = '$SYS/broker/subscriptions/count';
const SYS_CLIENTS = '$SYS/broker/clients/connected';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? `  —— ${extra}` : ''}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 内存里现造一台设备（**不落库**）；`caps` 里 `cmd:` / `state:` 即生产口径。 */
function dev(name: string, id: string, caps: string[]): AnsDevice {
  return {
    id, name, alias: '', kind: 'light', protocol: 'mqtt',
    address: mqttAddress(HOST, id), port: PORT,
    capabilities: caps, controllable: true, authorized: true, status: null, online: null,
  };
}

async function brokerReachable(): Promise<boolean> {
  return new Promise((resolve) => {
    const c = mqtt.connect(BROKER_URL, { connectTimeout: 1500, reconnectPeriod: 0, clientId: `wa-d1d2-probe-${process.pid}` });
    const done = (v: boolean) => { try { c.end(true); } catch { /* 噪声 */ } resolve(v); };
    c.once('connect', () => done(true));
    c.once('error', () => done(false));
    setTimeout(() => done(false), 2000);
  });
}

/** 长驻的 `$SYS` 读数器：连一次、持续收，取**最后一次**见到的值（避开 sys_interval 的陈旧值）。 */
function startSysReader(): { latest: (topic: string) => string | null; stop: () => void } {
  const seen = new Map<string, string>();
  const c = mqtt.connect(BROKER_URL, { connectTimeout: 2000, reconnectPeriod: 0, clientId: `wa-sys-${process.pid}-${Math.random().toString(16).slice(2, 8)}` });
  c.on('connect', () => { c.subscribe(SYS_SUBS, { qos: 0 }); c.subscribe(SYS_CLIENTS, { qos: 0 }); });
  c.on('message', (t, b) => { seen.set(String(t), String(b)); });
  c.on('error', () => { /* 读数失败 ⇒ latest 回 null，如实 */ });
  return { latest: (t) => seen.get(t) ?? null, stop: () => { try { c.end(true); } catch { /* 噪声 */ } } };
}

async function main(): Promise<void> {
  if (!(await brokerReachable())) {
    console.log(`\nSKIP：broker 不可达（${BROKER_URL}）——"环境没搭"不是"代码坏了"。`);
    console.log('  先起 broker 与模拟器：');
    console.log('    /opt/homebrew/opt/mosquitto/sbin/mosquitto -c /opt/homebrew/etc/mosquitto/mosquitto.conf -d');
    console.log('    node apps/worker-ant-desktop/scripts/ha-virtual-device.mjs up');
    process.exit(0);
  }

  // ── `--probe`：只读 $SYS 两值（D3 停机收摊前后各跑一次）──────────────────────────
  if (process.argv.includes('--probe')) {
    const sys = startSysReader();
    // ⚠ 须**静置过一整轮 `$SYS` 发布间隔**再读——否则拿到的是上一轮的 retained 值（陈旧读数）。
    await sleep(SYS_SETTLE_MS);
    console.log(JSON.stringify({
      subscriptions: sys.latest(SYS_SUBS),
      clients_connected: sys.latest(SYS_CLIENTS),
    }));
    sys.stop();
    process.exit(0);
  }

  const sys = startSysReader();

  // ── 阳性对照：真模拟器设备（`wa_sim/switch_1`）．它**会**回话，且回在**本次订阅的主题**上 ──
  const simSwitch = dev('客厅台灯', 'switch_1', [
    'mqtt', 'ha:switch', 'cmd:wa_sim/switch_1/set', 'state:wa_sim/switch_1/state',
  ]);
  // ── 幽灵：`cmd` 指向**真模拟器**（它会回话）·`state` 指向**没人发布**的主题 ────────
  //    修复前：那条回话（在 light_strip 主题上）被**忽略主题**的 `onMessage` 判成本次回执 ⇒ 假回执。
  //    修复后：只有 `wa_sim/ghost/state` 才算 ⇒ 超时 ⇒ 如实回"设备未回状态"。
  const ghost = dev('幽灵设备', 'ghost_1', [
    'mqtt', 'cmd:wa_sim/light_strip/set', 'state:wa_sim/ghost/state',
  ]);

  console.log('\n① 阳性对照：真设备（`wa_sim/switch_1`）⇒ 应真收回执');
  const rOk = await mqttDeviceControl(simSwitch, 'turn_on', {});
  check('真设备控制成功', rOk.ok === true, JSON.stringify(rOk).slice(0, 200));
  check('回执是**设备回话**（`设备回执：ON`）', /设备回执：ON\b/.test(rOk.result), rOk.result);

  console.log('\n② D1 反证：幽灵设备（cmd 指向真模拟器 / state 指向无人发布）⇒ 应如实回「设备未回」');
  const rGhost = await mqttDeviceControl(ghost, 'turn_on', {});
  check('幽灵设备仍判成功（broker PUBACK 为最小回执）', rGhost.ok === true, JSON.stringify(rGhost).slice(0, 200));
  check('★★回执**不是**设备回话（误把隔壁主题的 state 当本次回执即红）',
    !/设备回执/.test(rGhost.result), rGhost.result);
  check('★★如实说明「设备未在 3s 内回状态」', /设备未在 \d+s 内回状态/.test(rGhost.result), rGhost.result);

  console.log(`\n③ D2 订阅收支：连控 5 轮后 \`${SYS_SUBS}\` 应**不变**（修复前每控一台 +1）`);
  await sleep(SYS_SETTLE_MS); // 静置过一轮，取到本轮真实基线
  const before = sys.latest(SYS_SUBS);
  check('基线读数到手（非 null）', before !== null, String(before));
  for (let i = 0; i < 5; i++) {
    await mqttDeviceControl(simSwitch, 'turn_on', {});
    await mqttDeviceControl(ghost, 'turn_on', {});
  }
  await sleep(SYS_SETTLE_MS); // 再静置过一轮，让 broker 刷新计数
  const after = sys.latest(SYS_SUBS);
  check(`★★5 轮（10 次控制）后订阅数不变（before=${before} after=${after}）`,
    before !== null && after !== null && before === after,
    `订阅数涨了 ${before !== null && after !== null ? Number(after) - Number(before) : '?'} 条——即泄漏`);

  const clients = sys.latest(SYS_CLIENTS);
  console.log(`\n④ D3 参考读数：\`${SYS_CLIENTS}\` = ${clients}（退出桌面端后再跑 --probe，应回落 1）`);

  sys.stop();
  console.log(`\n══════ D1/D2：${pass} 通过 / ${fail} 失败 ══════`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('E2E 崩了：', e);
  process.exit(1);
});
