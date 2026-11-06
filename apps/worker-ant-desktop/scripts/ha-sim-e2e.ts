/**
 * ha-sim-e2e.ts —— **HA 标准桥的端到端核验**（真连 broker，真跑生产函数）。
 *
 * 与 `rr_zx_*.ts` 的分工：
 *   · rr 是**受控回归**——零外部依赖、假 IO、注入时钟，故能进 `pnpm rr:all`。
 *   · 本脚本**必须有活 broker**（真 MQTT 往返），**刻意不进 rr 套件**——
 *     否则没装 mosquitto 的机器上全量回归会假红（"环境缺件"被读成"代码坏了"）。
 *
 * 它跑的是**生产码原样**（不复制一份判据）：
 *   `haDiscoveryIo`（真 `mqtt` 订阅）→ `startDeviceDiscovery`/`upsertDiscovered` 落账
 *   → `setDeviceOnline`（可用性事件回填）→ `runDeviceControl`（K-6 闸）→ `recordDeviceAction`（留痕）
 *
 * 前置（缺一即 SKIP，退出码 0——"环境没搭"不是"代码坏了"）：
 *   1. 本机 broker 在 `HA_BROKER`（缺省 `mqtt://127.0.0.1:1883`）
 *   2. 模拟器在线：`node apps/worker-ant-desktop/scripts/ha-virtual-device.mjs up`
 *
 * 用法： ./node_modules/.bin/tsx apps/worker-ant-desktop/scripts/ha-sim-e2e.ts
 */
import { DatabaseSync } from 'node:sqlite';
import mqtt from 'mqtt';
import { haDiscoveryIo } from '../src/main/core/device-homeassistant.js';
import { startDeviceDiscovery, stopDeviceDiscovery } from '../src/main/core/device-discovery.js';
import {
  findDeviceByIdentity, listDevices, setDeviceAuthorized, setDeviceOnline,
  type AnsDevice, type DeviceDb, type DeviceControlOutcome,
} from '../src/main/core/device-registry.js';
import { mqttDeviceControl } from '../src/main/core/device-mqtt.js';
import { runDeviceControl } from '../src/main/core/tools/device.js';

const BROKER_URL = process.env.HA_BROKER || 'mqtt://127.0.0.1:1883';
const HOST = '127.0.0.1';
const PORT = 1883;
const PREFIX = 'homeassistant';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? `  —— ${extra}` : ''}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 被拒件的**类型窄化**（`DeviceControlOutcome` 是判别联合；`denied` 只在那支上）。 */
const isDenied = (r: DeviceControlOutcome): r is Extract<DeviceControlOutcome, { denied: true }> =>
  r.ok === false && 'denied' in r;

/** 取人话结果（放行件读 `result`、被拒件读 `error`）——判别联合的取值口，免去每处窄化。 */
const resultOf = (r: DeviceControlOutcome): string => (isDenied(r) ? r.error : r.result);

/** 等某条件成立（轮询；超时返回 false）。 */
async function waitFor(name: string, fn: () => boolean, ms = 6000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await sleep(120);
  }
  console.log(`  … 等待超时：${name}`);
  return false;
}

/** 建夹具库——DDL **逐列照抄** `database.ts` 的 `wa_devices` / `wa_device_actions`（含迁移后的 `online` 列）。 */
function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE wa_devices (
    id TEXT PRIMARY KEY, name TEXT DEFAULT '', alias TEXT DEFAULT '', kind TEXT DEFAULT 'unknown',
    protocol TEXT NOT NULL, address TEXT NOT NULL, port INTEGER,
    capabilities_json TEXT DEFAULT '[]', controllable INTEGER DEFAULT 0, authorized INTEGER DEFAULT 0,
    status_json TEXT, first_seen TEXT DEFAULT (datetime('now')), last_seen TEXT DEFAULT (datetime('now')),
    online INTEGER)`);
  db.exec(`CREATE UNIQUE INDEX idx_wa_devices_ident ON wa_devices(protocol, address)`);
  db.exec(`CREATE TABLE wa_device_actions (
    id TEXT PRIMARY KEY, device_id TEXT NOT NULL, action TEXT NOT NULL, args_json TEXT DEFAULT '{}',
    result TEXT DEFAULT '', task_id TEXT DEFAULT '', actor_kind TEXT DEFAULT '', actor_ref TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')))`);
  return db;
}

async function brokerReachable(): Promise<boolean> {
  return new Promise((resolve) => {
    const c = mqtt.connect(BROKER_URL, { connectTimeout: 1500, reconnectPeriod: 0, clientId: `wa-e2e-probe-${process.pid}` });
    const done = (v: boolean) => { try { c.end(true); } catch { /* 噪声 */ } resolve(v); };
    c.once('connect', () => done(true));
    c.once('error', () => done(false));
    setTimeout(() => done(false), 2000);
  });
}

async function main(): Promise<void> {
  if (!(await brokerReachable())) {
    console.log(`\nSKIP：broker 不可达（${BROKER_URL}）——"环境没搭"不是"代码坏了"。`);
    console.log('  先起 broker 与模拟器：');
    console.log('    /opt/homebrew/opt/mosquitto/sbin/mosquitto -c /opt/homebrew/etc/mosquitto/mosquitto.conf -d');
    console.log('    node apps/worker-ant-desktop/scripts/ha-virtual-device.mjs up');
    process.exit(0);
  }

  const raw = makeDb();
  const db = raw as unknown as DeviceDb;
  const found: AnsDevice[] = [];

  console.log('\n① 发现（haDiscoveryIo 真订阅 homeassistant/#，retained config 即刻到手）');
  const io = haDiscoveryIo({
    brokerHost: HOST,
    brokerPort: PORT,
    prefix: PREFIX,
    onError: (m) => console.log(`  [io.error] ${m}`),
    // 与 `ipc/devices.ipc.ts` 的 `applyAvailability` 同两行（落账后按地址找行 → 唯一写点回填）。
    onAvailability: (address, online) => {
      const d = findDeviceByIdentity(db, 'mqtt', address);
      if (d) setDeviceOnline(db, d.id, online);
    },
  });
  startDeviceDiscovery(db, { io, onDiscovered: (d) => { found.push(d); } });

  const got5 = await waitFor('5 台设备落账', () => listDevices(db).length >= 5);
  check('发现 5 台设备（switch/light/cover/sensor/lock）', got5, `实得 ${listDevices(db).length}`);

  const byName = (n: string) => listDevices(db).find((d) => d.name === n);
  const sw = byName('客厅台灯');
  const lt = byName('卧室灯带');
  const cv = byName('车库卷帘门');
  const sn = byName('客厅温度计');
  const lk = byName('前门智能锁');

  console.log('\n② 上行形状（缩写键 / `~` 展开 / dev 块名字回退 / 只读判 / 高危 kind）');
  check('switch 落账且名为自述名', sw?.kind === 'switch' && sw?.name === '客厅台灯');
  check('light 名字取自 device 块（无顶层 name）', lt?.name === '卧室灯带', `实得 ${lt?.name}`);
  check('light 的 `~/set` 已展开成 `wa_sim/light_strip/set`',
    lt?.capabilities.includes('cmd:wa_sim/light_strip/set') === true, JSON.stringify(lt?.capabilities));
  check('cover 落账 kind=cover', cv?.kind === 'cover');
  check('sensor 无 cmd_t ⇒ controllable=false（只读）', sn?.controllable === false);
  check('sensor 无 `cmd:` 能力', sn?.capabilities.some((c) => c.startsWith('cmd:')) === false);
  check('lock kind 逐字 lock（命中高危名单）', lk?.kind === 'lock');
  // ⚠ 以下数条用 `.every()`：**空表会真空通过**（`[].every(_)` 恒 true）——发现一旦落 0 台，
  //   它们会假绿，把"全都没发现"读成"形状全对"。故一律先钉**基数**再论断形状（`n === 5 && …`）。
  const nDevs = () => listDevices(db).length;
  check('台账地址含 broker 前缀 `127.0.0.1#<id>`',
    nDevs() === 5 && listDevices(db).every((d) => d.address.startsWith('127.0.0.1#')));
  check('首见 authorized 恒 false（发现 ≠ 授权）',
    nDevs() === 5 && listDevices(db).every((d) => d.authorized === false));

  console.log('\n③ 在线三态（只由可用性事件回填；discovery 载荷不置在线）');
  const allOnline = await waitFor('5 台全 online=true', () => nDevs() === 5 && listDevices(db).every((d) => d.online === true));
  check('可用性 retained `online` ⇒ 5 台全部 online=true', allOnline,
    JSON.stringify(listDevices(db).map((d) => [d.name, d.online])));
  // 反证：`last_seen` 不被在线态冒充——它记录"何时见到"，与"此刻在不在"是两列。
  check('online 与 last_seen 各写各列（不是同一个值换名）',
    nDevs() === 5 && listDevices(db).every((d) => typeof d.last_seen === 'string' && d.last_seen.length > 0));

  console.log('\n④ 控制闸（K-6 一处真源）——三拒一放');
  // 未授权 ⇒ 拒（denied），且**留痕**
  const deniedUnauth = await runDeviceControl(db, { deviceId: sw!.id, action: 'turn_on' }, (d, a, g) => mqttDeviceControl(d, a, g));
  check('未授权的 switch ⇒ 控制被拒（not_authorized）', isDenied(deniedUnauth) && deniedUnauth.reason === 'not_authorized',
    JSON.stringify(deniedUnauth).slice(0, 200));
  // 高危 ⇒ 即便授权也拒
  setDeviceAuthorized(db, lk!.id, true);
  const deniedLock = await runDeviceControl(db, { deviceId: lk!.id, action: 'turn_on' }, (d, a, g) => mqttDeviceControl(d, a, g));
  check('lock 即便授权也拒（high_risk）', isDenied(deniedLock) && deniedLock.reason === 'high_risk',
    JSON.stringify(deniedLock).slice(0, 200));
  // 只读 ⇒ 拒
  setDeviceAuthorized(db, sn!.id, true);
  const deniedSensor = await runDeviceControl(db, { deviceId: sn!.id, action: 'turn_on' }, (d, a, g) => mqttDeviceControl(d, a, g));
  check('sensor（不可控）⇒ 拒（not_controllable）', isDenied(deniedSensor) && deniedSensor.reason === 'not_controllable',
    JSON.stringify(deniedSensor).slice(0, 200));
  // 授权 + 可控 ⇒ 放，且真下发、真收回执
  setDeviceAuthorized(db, sw!.id, true);
  const okSwitch = await runDeviceControl(db, { deviceId: sw!.id, action: 'turn_on' }, (d, a, g) => mqttDeviceControl(d, a, g));
  check('授权的 switch turn_on ⇒ 成功', okSwitch.ok === true, JSON.stringify(okSwitch).slice(0, 240));
  check('回执含 HA 语言状态 `ON`（设备真回了 stat_t）',
    okSwitch.ok === true && /设备回执：ON\b/.test(resultOf(okSwitch)), resultOf(okSwitch));
  check('回执含命令主题 `wa_sim/switch_1/set`',
    okSwitch.ok === true && resultOf(okSwitch).includes('wa_sim/switch_1/set'));

  console.log('\n⑤ 带参命令走 JSON `{"state":…,…args}` 形');
  setDeviceAuthorized(db, lt!.id, true);
  const okLight = await runDeviceControl(db, { deviceId: lt!.id, action: 'turn_on', args: { brightness: 128 } },
    (d, a, g) => mqttDeviceControl(d, a, g));
  check('light turn_on{brightness:128} ⇒ 成功', okLight.ok === true, JSON.stringify(okLight).slice(0, 240));
  check('回执是 JSON 且含 brightness=128',
    okLight.ok === true && /"brightness":128/.test(resultOf(okLight)), resultOf(okLight));

  console.log('\n⑥ cover 语言（OPEN/CLOSE/STOP）');
  setDeviceAuthorized(db, cv!.id, true);
  const okCover = await runDeviceControl(db, { deviceId: cv!.id, action: 'open' }, (d, a, g) => mqttDeviceControl(d, a, g));
  check('cover open ⇒ 成功且回执 `OPEN`', okCover.ok === true && /设备回执：OPEN\b/.test(resultOf(okCover)),
    resultOf(okCover));

  console.log('\n⑦ 留痕（wa_device_actions：含被拒件）');
  const rows = raw.prepare('SELECT device_id, action, result FROM wa_device_actions ORDER BY created_at').all() as Array<Record<string, unknown>>;
  check('留痕 6 行（3 拒 + 3 放）', rows.length === 6, `实得 ${rows.length}：${JSON.stringify(rows)}`);
  check('被拒件也留痕（result=denied ×3）', rows.filter((r) => r.result === 'denied').length === 3,
    JSON.stringify(rows.filter((r) => r.result === 'denied')));
  check('放行件留痕（result=ok ×3）', rows.filter((r) => r.result === 'ok').length === 3,
    JSON.stringify(rows.filter((r) => r.result === 'ok')));

  console.log('\n⑧ 可用性翻转 ⇒ 在线态跟着翻（主动离线）');
  const pub = mqtt.connect(BROKER_URL, { connectTimeout: 2000, reconnectPeriod: 0, clientId: `wa-e2e-pub-${process.pid}` });
  await new Promise<void>((r) => pub.once('connect', () => r()));
  await new Promise<void>((r) => pub.publish('wa_sim/switch_1/availability', 'offline', { qos: 1, retain: true }, () => r()));
  const flipped = await waitFor('switch online=false', () => (byName('客厅台灯')?.online ?? null) === false, 4000);
  check('发 `offline` ⇒ switch online=false', flipped, `实得 ${byName('客厅台灯')?.online}`);
  check('其余设备不受影响（仍 online=true）', ['卧室灯带', '车库卷帘门'].every((n) => byName(n)?.online === true));
  // 复原
  await new Promise<void>((r) => pub.publish('wa_sim/switch_1/availability', 'online', { qos: 1, retain: true }, () => r()));
  await waitFor('switch 复在线', () => (byName('客厅台灯')?.online ?? null) === true, 4000);
  pub.end(true);

  stopDeviceDiscovery();
  raw.close();

  console.log(`\n══════ 端到端：${pass} 通过 / ${fail} 失败 ══════`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('E2E 崩了：', e);
  process.exit(1);
});
