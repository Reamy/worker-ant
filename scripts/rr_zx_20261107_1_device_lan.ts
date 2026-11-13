/**
 * zx_20261107_1「实·通·信」B1 受控回归 —— 局域网：多服务发现、SSDP 描述解析、私网控制收口。
 *
 * A 类别派生：窗帘/空调/风扇/门锁各归其类，认不出即 unknown（不硬塞）。
 * B mDNS：多服务类型各自成条；协议记 mdns、端口/能力取自述。
 * C SSDP：描述文档补齐 friendlyName/modelName/deviceType；缺描述时仍可用头部。
 * D 地址收口：私网放行、公网拒、云元数据端点单独拒。
 * E 控制收口：公网地址在发出站前即拒（不触网）。
 *
 * 纪律：零网络 / 零 electron / 零时钟；只用纯函数与注入假 fetch。
 */
import {
  MDNS_SERVICE_TYPES,
  deriveDeviceKind,
  mdnsToDiscovered,
  parseDeviceDescription,
  ssdpToDiscovered,
} from '../apps/worker-ant-desktop/src/main/core/device-discovery.js';
import { lanAddressRefusal } from '../apps/worker-ant-desktop/src/main/core/device-address.js';
import { httpDeviceControl } from '../apps/worker-ant-desktop/src/main/core/tools/device.js';
import type { AnsDevice } from '../apps/worker-ant-desktop/src/main/core/device-registry.js';
import type { SsdpHeaders } from 'node-ssdp';

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  PASS ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}

// A 类别派生
ok(deriveDeviceKind('_hap._tcp WindowCovering') === 'curtain', 'A1 窗帘自述归 curtain');
ok(deriveDeviceKind('air-conditioner climate') === 'aircon', 'A2 空调自述归 aircon');
ok(deriveDeviceKind('ventilator fan') === 'fan', 'A3 风扇自述归 fan');
ok(deriveDeviceKind('doorlock security') === 'lock', 'A4 门锁自述归 lock');
ok(deriveDeviceKind('mystery-service') === 'unknown', 'A5 认不出即 unknown');

// B mDNS 多服务
ok(MDNS_SERVICE_TYPES.includes('http') && MDNS_SERVICE_TYPES.includes('hap')
  && MDNS_SERVICE_TYPES.includes('esphomelib') && MDNS_SERVICE_TYPES.includes('home-assistant'),
'A6 默认 mDNS 服务类型含四类');
const mdns = mdnsToDiscovered({
  name: 'Living Curtain', type: '_hap._tcp', host: 'curtain.local', port: 51827,
  addresses: ['192.168.1.20'], txt: { md: 'Curtain', cmd: 'open' },
});
ok(mdns?.protocol === 'mdns' && mdns?.kind === 'curtain' && mdns?.port === 51827,
  'B1 mDNS 条带协议/类别/端口', JSON.stringify(mdns));
ok(mdns?.controllable === true, 'B2 TXT 自述 cmd ⇒ controllable');
ok(mdnsToDiscovered({ name: 'x' }) == null, 'B3 无地址不落条');

// C SSDP 描述
const xml = '<root><device><friendlyName>客厅空调</friendlyName><modelName>AC-1</modelName>'
  + '<deviceType>urn:schemas-upnp-org:device:HVAC:1</deviceType><manufacturer>Acme</manufacturer></device></root>';
const desc = parseDeviceDescription(xml);
ok(desc.friendlyName === '客厅空调' && desc.modelName === 'AC-1' && desc.deviceType?.includes('HVAC'),
  'C1 描述字段解析', JSON.stringify(desc));
const headers = {
  ST: 'urn:schemas-upnp-org:device:HVAC:1', NT: 'upnp:rootdevice', SERVER: 'Linux/1.0 UPnP/1.1',
  USN: 'uuid:ac-1', LOCATION: 'http://192.168.1.30:8080/desc.xml',
} as unknown as SsdpHeaders;
const withDesc = ssdpToDiscovered(headers, '192.168.1.30', desc);
ok(withDesc?.name === '客厅空调' && withDesc?.kind === 'aircon' && withDesc?.port === 8080,
  'C2 描述补齐名称/类别/端口', JSON.stringify(withDesc));
ok((withDesc?.capabilities ?? []).some((c) => c.includes('AC-1')), 'C3 描述字段进能力自述');
const noDesc = ssdpToDiscovered(headers, '192.168.1.30', null);
ok(noDesc?.name === 'Linux/1.0 UPnP/1.1' && noDesc?.port === 8080, 'C4 无描述时仍可用头部');

// D 地址收口
ok(lanAddressRefusal('192.168.1.10') == null, 'D1 私网放行');
ok(lanAddressRefusal('10.0.0.2') == null, 'D2 10/8 放行');
ok(lanAddressRefusal('8.8.8.8') != null, 'D3 公网拒');
ok(lanAddressRefusal('169.254.169.254')?.includes('云元数据') === true, 'D4 云元数据端点单独拒');

// E 控制收口（公网地址在 fetch 前即拒）
const dev = {
  id: 'd1', name: 'public', alias: '', room: '', kind: 'switch', kind_class: 'switch',
  protocol: 'http', address: '8.8.8.8', port: 80, capabilities: [], controllable: true,
  authorized: true, status: null, desired: null, online: null, first_seen: '', last_seen: '',
} as AnsDevice;
void httpDeviceControl(dev, 'on', {}).then((r) => {
  ok(r.ok === false && r.result.includes('非局域网'), 'E1 公网控制地址在发出站前即拒', r.result);
  console.log(`\n[rr_zx_20261107_1_device_lan] ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
});
