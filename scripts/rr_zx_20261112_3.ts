/**
 * zx_20261112_3「名」——入站 mDNS 广播改用节点自持主机名，不再借用系统 LocalHostName。
 *
 * 判据分组（随批次逐步补齐）：
 *   S「基」构建钉 P1–P6 + 本轮方案在册与范围拍板。
 *   M「名」派生主机名形状/确定性/反证、工厂第三参、启动接线、真 publish 选项含 host。
 *
 * 纪律：
 *   - 不真广播（`mdnsFactory` 用捕获桩；真网络验证由收口探针单独做）；
 *   - 轮次钉由 checkBuildPins 从真源派生，不写「只为下一轮」的字面量；
 *   - 断言文案禁含失败字形（汇总器按字形计数）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';
import {
  INBOUND_MDNS_SERVICE,
  inboundMdnsHostName,
  startInboundGate,
  stopInboundGate,
  type InboundServer,
  type InboundServerFactory,
} from '../apps/worker-ant-desktop/src/main/core/inbound-gate.js';

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  PASS ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}
function eq(a: unknown, b: unknown, label: string): void {
  ok(JSON.stringify(a) === JSON.stringify(b), label, `${JSON.stringify(a)} = ${JSON.stringify(b)}`);
}

const root = path.join(__dirname, '..');
const A = 'apps/worker-ant-desktop';
const readSrc = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf-8');
const codeOf = (rel: string): string => stripKeepingLines(readSrc(rel)).join('\n');

function sectionS(): void {
  console.log('\n【S】构建钉与本轮方案');
  checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });

  const selfRound = path.basename(__filename, '.ts').replace(/^rr_/, '');
  const plan = readSrc(`plans/improve/${selfRound}.md`);
  ok(plan.includes(selfRound), 'S1 本轮方案在册且带轮次名');
  ok(plan.includes('不再借用系统主机名') && plan.includes('workerant-'),
    'S2 方案记下「广播主机名自持」这一刀（防实施时漂移）');
  ok(plan.includes('不启动 Electron 桌面'),
    'S3 方案记下收口用受控探针、不擅自起桌面（GUI 目视须另行征得同意）');
}

/** 假 server：不真开网卡（与 `rr_zx_20261014_4` 同一范式）。 */
function fakeServerFactory(): InboundServerFactory {
  return () => ({
    listen(_port: number, cb: () => void) { cb(); },
    close(cb: () => void) { cb(); },
    on() { /* 假 server 不上报 error */ },
  });
}

function sectionM(): void {
  console.log('\n【M】B1「名」广播主机名自持');

  const nodeId = 'dd647fb4-a4da-44ab-a0d1-f69646c47573';
  const host = inboundMdnsHostName(nodeId);
  ok(/^workerant-[0-9a-f]{8}\.local$/.test(host), 'M-01 形状：`workerant-<8hex>.local`', host);
  ok(host.length <= 63, 'M-02 DNS 标签长度有界（≤63）');
  eq(inboundMdnsHostName(nodeId), inboundMdnsHostName(nodeId), 'M-03 同 seed 同值（重启不变）');
  ok(inboundMdnsHostName('node-a') !== inboundMdnsHostName('node-b'), 'M-03b 异 seed 异值（局域网内不互撞）');

  const sys = os.hostname();
  ok(inboundMdnsHostName(sys) !== sys, 'M-04 ★反证：即使拿系统主机名当 seed，派生值也绝不回吐它', sys);
  ok(inboundMdnsHostName('   ') !== '', 'M-04b 空 seed 不留空名（退到哈希输入）');
  ok(/^workerant-[0-9a-f]{8}\.local$/.test(inboundMdnsHostName('   ')), 'M-04c 空 seed 仍是合法自持名');

  // ── 行为：工厂第三参就是广播主机名，且不等于系统主机名 ──────────────────
  const seen: Array<{ name: string; port: number; host?: string }> = [];
  const captureFactory = (name: string, port: number, h?: string) => {
    seen.push({ name, port, host: h });
    return { stop() { /* 记录用，无需停 */ } };
  };
  const r1 = startInboundGate({
    enabled: true, nodeName: () => 'Dev', agentVersion: '0.1.0',
    serverFactory: fakeServerFactory(), mdnsFactory: captureFactory, port: 27199,
  });
  eq(r1.started, true, 'M-05 假 server 下门真起（行为夹具成立）');
  eq(seen.length, 1, 'M-05b 广播工厂恰被调用 1 次');
  eq(seen[0]?.name, 'Dev', 'M-06 实例名仍是 nodeName（不误改服务实例名）');
  eq(seen[0]?.host, inboundMdnsHostName('Dev'), 'M-07 ★缺省 mdnsHost ⇒ 工厂第三参＝派生自持名');
  ok(seen[0]?.host !== os.hostname(), 'M-08 ★★第三参 ≠ os.hostname()（不再与系统 LocalHostName 抢名）');
  stopInboundGate();

  const seen2: Array<string | undefined> = [];
  const captureFactory2 = (_name: string, _port: number, h?: string) => {
    seen2.push(h);
    return { stop() { /* 记录用 */ } };
  };
  startInboundGate({
    enabled: true, nodeName: () => 'Dev', agentVersion: '0.1.0',
    serverFactory: fakeServerFactory(), mdnsFactory: captureFactory2, port: 27199,
    mdnsHost: inboundMdnsHostName('node-id-x'),
  });
  eq(seen2[0], inboundMdnsHostName('node-id-x'), 'M-09 显式 mdnsHost 原样传给工厂（装配层可指定）');
  stopInboundGate();

  // ── 静态：真 publish 选项含 host / 装配层接线 / 服务类型未改 ──────────────
  const gate = codeOf(`${A}/src/main/core/inbound-gate.ts`);
  ok(gate.includes('host: advertisedHost'), 'M-10 ★真 `publish` 选项显式带 host（不是只加参数不用）');
  ok(gate.includes('const advertisedHost = (host ?? \'\').trim() || inboundMdnsHostName(nodeName)'),
    'M-11 工厂内兜底也走派生（省略 host 时才派生，绝不回落系统名）');
  const idx = codeOf(`${A}/src/main/index.ts`);
  ok(/mdnsHost:\s*inboundMdnsHostName\(identity\.id\)/.test(idx),
    'M-12 ★★接线那一跳：装配层用节点 id 派生命名传给 `mdnsHost`');
  ok(gate.includes("type: INBOUND_MDNS_SERVICE"), 'M-13 服务类型未改（仍 `_workerant._tcp`）');
  eq(INBOUND_MDNS_SERVICE, 'workerant', 'M-14 服务类型字面值未改');
  ok(!/publish\(\{[^)]*host:\s*(osHostname\(\)|os\.hostname\(\))/.test(gate),
    'M-15 ★反证：publish 的 host 不得直接取系统主机名');
}

async function main(): Promise<void> {
  sectionS();
  sectionM();

  console.log(`\n[rr_zx_20261112_3] ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e: unknown) => {
  console.error('\nrr_zx_20261112_3 未捕获异常（复跑未跑完，不得读作通过）：', e);
  console.log(`\n[rr_zx_20261112_3] ${pass} passed, ${fail + 1} failed`);
  process.exit(1);
});
