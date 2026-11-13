/**
 * zx_20261107_1「实·通·信」B2 受控回归 —— 设备云渠道：可配置、可回读、可审计。
 *
 * A 渠道目录：HA 有 MQTT 与 REST 两条真实接入路，目录须各列一条；云渠道凭据归账号表。
 * B 涂鸦云：假 HTTP 跑真 Provider——令牌/列表/控制/状态/鉴权失败/网络失败。
 * C Home Assistant：假 HTTP 跑真 Provider——列表/控制/状态/401/传输抛错。
 * D MQTT：假 IO 跑真控制路——成功/设备侧失败/传输抛错。
 * E 编排：真 `runDeviceControl` + 注入传动与回读——成功、回读不符、回读超时（影子如实）。
 *
 * 纪律：零网络 / 零 electron / 零墙钟；只用注入假 transport 与 node:sqlite 内存库。
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import {
  TUYA_REGION_HOSTS,
  createTuyaProvider,
  tuyaCommands,
  type TuyaHttp,
} from '../apps/worker-ant-desktop/src/main/core/providers/tuya-cloud.js';
import {
  createHaRestProvider,
  haServiceFor,
  type HaHttp,
} from '../apps/worker-ant-desktop/src/main/core/providers/homeassistant-rest.js';
import { mqttDeviceControl, type MqttIo } from '../apps/worker-ant-desktop/src/main/core/device-mqtt.js';
import { runDeviceControl } from '../apps/worker-ant-desktop/src/main/core/tools/device.js';
import {
  deviceShadow,
  getDevice,
  type AnsDevice,
  type DeviceDb,
} from '../apps/worker-ant-desktop/src/main/core/device-registry.js';
import {
  channelForProtocol,
  getChannel,
  listChannels,
} from '../apps/worker-ant-desktop/src/main/core/device-channel.js';

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
const CODE = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf-8');

/* ── 夹具 DDL：照 `database.ts` 的列形（只建本套件读到的表） ─────────────── */
const SCHEMA = `
CREATE TABLE wa_devices (
  id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', alias TEXT NOT NULL DEFAULT '', room TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'unknown', kind_class TEXT NOT NULL DEFAULT '', protocol TEXT NOT NULL DEFAULT 'mdns',
  address TEXT NOT NULL DEFAULT '', port INTEGER, capabilities_json TEXT NOT NULL DEFAULT '[]',
  controllable INTEGER NOT NULL DEFAULT 0, authorized INTEGER NOT NULL DEFAULT 0, status_json TEXT,
  desired_json TEXT,
  online INTEGER, first_seen TEXT NOT NULL DEFAULT '', last_seen TEXT NOT NULL DEFAULT ''
);
CREATE TABLE wa_device_actions (
  id TEXT PRIMARY KEY, device_id TEXT NOT NULL, action TEXT NOT NULL, args_json TEXT DEFAULT '{}',
  result TEXT DEFAULT '', task_id TEXT DEFAULT '', actor_kind TEXT DEFAULT '', actor_ref TEXT DEFAULT '',
  plan_id TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now'))
);
`;
function makeDb(): DatabaseSync {
  const d = new DatabaseSync(':memory:');
  d.exec(SCHEMA);
  return d;
}

function insertDevice(db: DatabaseSync, over: Partial<AnsDevice> & { id: string }): AnsDevice {
  const dev: AnsDevice = {
    id: over.id,
    name: over.name ?? '灯',
    alias: over.alias ?? '',
    room: over.room ?? '',
    kind: over.kind ?? 'light',
    kind_class: over.kind_class ?? 'light',
    protocol: over.protocol ?? 'cloud',
    address: over.address ?? 'tuya@acc:d1',
    port: over.port ?? null,
    capabilities: over.capabilities ?? ['switch_1'],
    controllable: over.controllable ?? true,
    authorized: over.authorized ?? true,
    status: over.status ?? null,
    desired: over.desired ?? null,
    online: over.online ?? true,
    first_seen: over.first_seen ?? '2026-11-07 00:00:00',
    last_seen: over.last_seen ?? '2026-11-07 00:00:00',
  };
  db.prepare(`INSERT INTO wa_devices
    (id, name, alias, room, kind, kind_class, protocol, address, port, capabilities_json,
     controllable, authorized, status_json, desired_json, online, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`)
    .run(dev.id, dev.name, dev.alias, dev.room, dev.kind, dev.kind_class, dev.protocol, dev.address,
      dev.port, JSON.stringify(dev.capabilities), dev.controllable ? 1 : 0, dev.authorized ? 1 : 0,
      dev.online == null ? null : (dev.online ? 1 : 0), dev.first_seen, dev.last_seen);
  return dev;
}

/* ═══ A 渠道目录 ═══════════════════════════════════════════════════════════ */
console.log('\n【A】渠道目录：HA 两条路各列一条，云渠道凭据归账号表');
{
  eq(listChannels().map((c) => c.id),
    ['lan', 'mqtt', 'homeassistant', 'tuya-cloud', 'homeassistant-rest', 'mijia-miio'],
    'A1 六渠道逐个枚举（含 HA REST）');
  eq(getChannel('tuya-cloud')?.accountProvider, 'tuya', 'A2 涂鸦渠道凭据归账号表');
  eq(getChannel('homeassistant-rest')?.accountProvider, 'homeassistant', 'A3 HA REST 渠道凭据归账号表');
  eq(getChannel('homeassistant-rest')?.kind, 'cloud', 'A4 HA REST 是厂商云形态（不是网关）');
  eq(getChannel('homeassistant-rest')?.protocols, ['cloud'], 'A5 HA REST 产出 cloud 协议');
  eq(getChannel('homeassistant')?.kind, 'gateway', 'A6 HA MQTT 仍是网关形态（两条路不混）');
  eq(channelForProtocol('cloud')?.id, 'tuya-cloud', 'A7 cloud 协议按注册顺序归首个渠道（不抢解释权）');

  const ipc = CODE('apps/worker-ant-desktop/src/main/ipc/devices.ipc.ts');
  ok(ipc.includes('channel.accountProvider != null') && ipc.includes('listCloudAccounts(ddb).some'),
    'A8 渠道预检认账号表（账号配好即就绪，不再只认旧 settings 键）');
  const wizard = CODE('apps/worker-ant-desktop/renderer/src/components/DeviceOnboardingWizard.tsx');
  ok(wizard.includes('channel.accountProvider != null') && wizard.includes('baseProviderOfAddress'),
    'A9 向导按账号基名归属云设备（两个云渠道不互抢）');
  ok(wizard.includes('设备云账号'), 'A10 向导指向账号表入口（说了点得到）');
  const page = CODE('apps/worker-ant-desktop/renderer/src/pages/DevicesPage.tsx');
  ok(page.includes('cloudAccounts()') && page.includes('未配置凭据'),
    'A11 设备页有账号入口与"未配置"如实标记');
}

async function main(): Promise<void> {
/* ═══ B 涂鸦云（假 HTTP 跑真 Provider） ════════════════════════════════════ */
console.log('\n【B】涂鸦云：令牌 → 列表 → 控制 → 状态，四态如实');
{
  const cfg = { region: 'cn' as const, accessId: 'ak', accessSecret: 'sk' };
  const host = TUYA_REGION_HOSTS.cn;
  const now = () => new Date('2026-11-07T10:00:00Z');
  const recorder = (handler: (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => { status: number; body: string }) => {
    const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = [];
    const http: TuyaHttp = async (url, init) => {
      calls.push({ url, ...init });
      return handler(url, init);
    };
    return { http, calls };
  };
  const tokenBody = JSON.stringify({ success: true, result: { access_token: 'tok-1', expire_time: 7200 } });

  // B1 列表成功：能力取设备自述数据点
  {
    const { http, calls } = recorder((url) => {
      if (url.includes('/v1.0/token')) return { status: 200, body: tokenBody };
      if (url.includes('/v1.0/devices?page_no=1')) return {
        status: 200,
        body: JSON.stringify({ success: true, result: {
          has_more: false,
          devices: [
            { id: 'd1', name: '客厅灯', category: 'dj', status: [{ code: 'switch_1', value: true }] },
            { id: '', name: '无 id 行' },
          ],
        } }),
      };
      return { status: 404, body: 'nope' };
    });
    const devs = await createTuyaProvider(cfg, { http, now }).listDevices();
    eq(devs.map((d) => d.id), ['d1'], 'B1 列表只收有 id 的设备（无 id 不造行）');
    eq(devs[0]?.capabilities, ['switch_1'], 'B2 能力取设备自述数据点');
    eq(devs[0]?.controllable, true, 'B3 有数据点才可控');
    ok(calls[0]?.headers.client_id === 'ak' && typeof calls[0]?.headers.sign === 'string',
      'B4 请求带涂鸦签名头');
    ok(calls.every((c) => c.url.startsWith(host)), 'B5 只发官方区域端点');
  }

  // B6 控制成功
  {
    const { http, calls } = recorder((url) => {
      if (url.includes('/v1.0/token')) return { status: 200, body: tokenBody };
      if (url.endsWith('/v1.0/devices/d1/commands')) return { status: 200, body: JSON.stringify({ success: true, result: true }) };
      return { status: 404, body: 'nope' };
    });
    const r = await createTuyaProvider(cfg, { http, now }).control('d1', 'turn_on', {});
    eq(r.ok, true, 'B6 控制成功');
    const post = calls.find((c) => c.method === 'POST');
    eq(post && JSON.parse(post.body ?? '{}'), { commands: [{ code: 'switch_1', value: true }] },
      'B7 控制体是涂鸦 commands 形（turn_on ⇒ switch_1=true）');
  }

  // B8 鉴权失败：401 如实抛（同步层收成空态+原因）
  {
    const { http } = recorder(() => ({ status: 401, body: '{"success":false,"code":1004}' }));
    let threw = '';
    try { await createTuyaProvider(cfg, { http, now }).listDevices(); }
    catch (e) { threw = (e as Error)?.message || String(e); }
    ok(threw.includes('HTTP 401'), 'B8 鉴权失败如实抛（不拿旧令牌冒充成功）', threw);
  }

  // B9 网络失败：控制回 ok:false，不抛
  {
    const http: TuyaHttp = async () => { throw new Error('connect ECONNREFUSED'); };
    const r = await createTuyaProvider(cfg, { http, now }).control('d1', 'turn_on', {});
    eq(r.ok, false, 'B9 传输抛错 ⇒ 控制如实失败');
    ok(r.result.includes('ECONNREFUSED'), 'B10 失败原因原样带上', r.result);
  }

  // B11 业务失败：success=false 也是失败
  {
    const { http } = recorder((url) => {
      if (url.includes('/v1.0/token')) return { status: 200, body: tokenBody };
      return { status: 200, body: JSON.stringify({ success: false, code: 2001, msg: 'device offline' }) };
    });
    const r = await createTuyaProvider(cfg, { http, now }).control('d1', 'turn_on', {});
    eq(r.ok, false, 'B11 云端 success=false ⇒ 失败（不看 HTTP 200 就报成功）');
    ok(r.result.includes('2001'), 'B12 业务错误码上屏', r.result);
  }

  // B13 状态查询：values/online 原样透传
  {
    const { http } = recorder((url) => {
      if (url.includes('/v1.0/token')) return { status: 200, body: tokenBody };
      return {
        status: 200,
        body: JSON.stringify({ success: true, result: { online: true, status: [{ code: 'switch_1', value: true }] } }),
      };
    });
    const st = await createTuyaProvider(cfg, { http, now }).getState!('d1');
    eq(st.ok, true, 'B13 状态查询成功');
    eq(st.state, { values: { switch_1: true }, online: true }, 'B14 状态原样透传（不编字段）');
  }

  // B15 未给数据点 code 的动作如实拒（不猜）
  eq(tuyaCommands('set_bright', { value: 80 }), { error: '动作「set_bright」需在参数里给出涂鸦数据点 code（turn_on/turn_off 除外），拒绝猜测。' },
    'B15 表外动作缺 code 如实拒');
}

/* ═══ C Home Assistant（假 HTTP 跑真 Provider） ═══════════════════════════ */
console.log('\n【C】Home Assistant：列表 / 控制 / 状态 / 401 / 传输抛错');
{
  const cfg = { baseUrl: 'http://ha.local:8123', token: 'tok-ha' };
  const recorder = (handler: (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => { status: number; body: string }) => {
    const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = [];
    const http: HaHttp = async (url, init) => {
      calls.push({ url, ...init });
      return handler(url, init);
    };
    return { http, calls };
  };

  // C1 列表
  {
    const { http, calls } = recorder(() => ({
      status: 200,
      body: JSON.stringify([
        { entity_id: 'light.living', state: 'on', attributes: { friendly_name: '客厅灯' } },
        { entity_id: 'sensor.temp', state: '26', attributes: {} },
      ]),
    }));
    const devs = await createHaRestProvider(cfg, { http }).listDevices();
    eq(devs.map((d) => d.id), ['light.living'], 'C1 只收可控域实体（sensor 不收）');
    eq(calls[0]?.headers.Authorization, 'Bearer tok-ha', 'C2 令牌走 Bearer 头');
  }

  // C3 控制成功
  {
    const { http, calls } = recorder(() => ({ status: 200, body: '[]' }));
    const r = await createHaRestProvider(cfg, { http }).control('light.living', 'turn_on', { brightness: 80 });
    eq(r.ok, true, 'C3 控制成功');
    eq(calls[0]?.url, 'http://ha.local:8123/api/services/light/turn_on', 'C4 控制走 HA service 端点');
    eq(JSON.parse(calls[0]?.body ?? '{}'), { entity_id: 'light.living', brightness: 80 },
      'C5 控制体含 entity_id 且剥掉 args.service');
    eq(haServiceFor('cover.garage', 'open', {}), { domain: 'cover', service: 'open_cover' },
      'C6 封面开动作映射 open_cover');
  }

  // C7 鉴权失败
  {
    const { http } = recorder(() => ({ status: 401, body: 'unauthorized' }));
    const r = await createHaRestProvider(cfg, { http }).control('light.living', 'turn_on', {});
    eq(r.ok, false, 'C7 401 ⇒ 控制如实失败');
    ok(r.result.includes('401'), 'C8 鉴权失败原因上屏', r.result);
  }

  // C9 传输抛错
  {
    const http: HaHttp = async () => { throw new Error('socket hang up'); };
    const r = await createHaRestProvider(cfg, { http }).control('light.living', 'turn_on', {});
    eq(r.ok, false, 'C9 传输抛错 ⇒ 控制如实失败');
    ok(r.result.includes('socket hang up'), 'C10 原因原样带上', r.result);
  }

  // C11 状态
  {
    const { http } = recorder(() => ({
      status: 200,
      body: JSON.stringify({ entity_id: 'light.living', state: 'off', attributes: { brightness: 10 } }),
    }));
    const st = await createHaRestProvider(cfg, { http }).getState!('light.living');
    eq(st.ok, true, 'C11 状态查询成功');
    ok(st.state?.state === 'off', 'C12 状态值原样带回');
  }
}

/* ═══ D MQTT（假 IO 跑真控制路） ═══════════════════════════════════════════ */
console.log('\n【D】MQTT：成功 / 设备侧失败 / 传输抛错');
{
  const dev: AnsDevice = {
    id: 'm1', name: '灯', alias: '', room: '', kind: 'light', kind_class: 'light',
    protocol: 'mqtt', address: '192.168.1.5#dev-1', port: 1883, capabilities: ['turn_on', 'turn_off'],
    controllable: true, authorized: true, status: null, desired: null, online: true,
    first_seen: '', last_seen: '',
  };
  const io = (fn: MqttIo['publish']): MqttIo => ({ publish: fn });
  {
    const r = await mqttDeviceControl(dev, 'turn_on', {}, io(async () => ({ ok: true, ack: 'on' })));
    eq(r.ok, true, 'D1 发布成功');
    ok(r.result.includes('on'), 'D2 设备回执随结果上屏', r.result);
  }
  {
    const r = await mqttDeviceControl(dev, 'turn_on', {}, io(async () => ({ ok: false, error: 'ACL denied' })));
    eq(r.ok, false, 'D3 设备侧失败 ⇒ ok:false');
    ok(r.result.includes('ACL denied'), 'D4 失败原因上屏', r.result);
  }
  {
    const r = await mqttDeviceControl(dev, 'turn_on', {}, io(async () => { throw new Error('broker closed'); }));
    eq(r.ok, false, 'D5 传输抛错 ⇒ ok:false');
    ok(r.result.includes('broker closed'), 'D6 原因上屏', r.result);
  }
}

/* ═══ E 编排：真 runDeviceControl + 注入传动/回读 ═══════════════════════════ */
console.log('\n【E】控制编排：成功与回读核验（影子如实）');
{
  const db = makeDb() as unknown as DeviceDb;
  insertDevice(db as unknown as DatabaseSync, { id: 'v1', address: 'tuya@acc:d1', protocol: 'cloud', capabilities: ['switch_1'] });

  // E1 下发成功 + 回读状态相反 ⇒ 影子判"不符"（不冒充成功生效）
  {
    const out = await runDeviceControl(db, {
      deviceId: 'v1',
      action: 'turn_on',
      readback: async () => ({ ok: true, state: { state: 'off' } }),
    }, async () => ({ ok: true, result: '已受理' }));
    eq(out.ok, true, 'E1 控制本身成功');
    const dev = getDevice(db, 'v1')!;
    eq(deviceShadow(dev).match, false, 'E2 回读状态相反 ⇒ 影子判不符');
    ok(dev.desired?.verify_error === undefined, 'E3 回读成功写时刻而非错误');
  }

  // E4 回读超时 ⇒ verify_error 如实留痕，控制结果仍是 ok
  {
    const out = await runDeviceControl(db, {
      deviceId: 'v1',
      action: 'turn_off',
      readbackTimeoutMs: 25,
      readback: () => new Promise(() => { /* 永不返回 */ }),
    }, async () => ({ ok: true, result: '已受理' }));
    eq(out.ok, true, 'E4 回读超时不改控制结果');
    const dev = getDevice(db, 'v1')!;
    eq(deviceShadow(dev).match, null, 'E5 核验失败 ⇒ 不判（null，不是 false）');
    ok(String(dev.desired?.verify_error ?? '').includes('回读超时'), 'E6 失败原因如实留在影子里',
      String(dev.desired?.verify_error ?? ''));
  }

  // E7 未授权设备：审计留 denied，传动一次都不调
  {
    const db2 = makeDb() as unknown as DeviceDb;
    insertDevice(db2 as unknown as DatabaseSync, { id: 'v2', address: 'tuya@acc:d2', authorized: false });
    let calls = 0;
    const out = await runDeviceControl(db2, { deviceId: 'v2', action: 'turn_on' },
      async () => { calls += 1; return { ok: true, result: '不应到达' }; });
    eq(out.ok, false, 'E7 未授权 ⇒ 控制被拒');
    eq(calls, 0, 'E8 被拒则不触传动（0→0 反证）');
    const rows = (db2 as unknown as DatabaseSync).prepare(
      "SELECT result FROM wa_device_actions WHERE device_id = 'v2'").all() as Array<{ result: string }>;
    eq(rows.map((r) => r.result), ['denied'], 'E9 被拒同样留审计（denied）');
  }
}

}

main().then(() => {
  console.log(`\n[rr_zx_20261107_1_device_cloud] ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
