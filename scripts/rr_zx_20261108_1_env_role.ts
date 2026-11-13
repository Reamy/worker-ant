/**
 * zx_20261108_1 B2「境·识」受控回归 —— 环境上屏与角色建议（亚里士多德·潜能成现实 / 管子·量力而行）。
 *
 * 钉住四件事：
 *   A 建议四态：离线 / 余力过低 / 余力充足且可靠 / 样本不足——建议角色与理由各自成立；
 *   B 同一把尺：余力/成功率/样本下限取自 `node-match`（不在建议模块另抄一份）；
 *   C 只建议不写库：建议模块零 IO、无 db 参数、无 prepare/run/INSERT，采纳须页面显式调 `nodes:update`；
 *   D 展示投影不抛：坏 `capacity_basis` / 坏 `os_release` / 坏 `disk_spare` ⇒ null；磁盘/瓶颈人话如实。
 *
 * 纪律：零网络 / 零 electron / 零时钟；断言只做方向性与包含关系，不抄分数幻数；文案不含失败字形。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  BOTTLENECK_LABEL,
  suggestNodeRole,
  type RoleAdviceInput,
} from '../apps/worker-ant-desktop/src/main/core/node-role-advice.js';
import { MIN_FREE_RATIO, MIN_RELIABILITY_SAMPLES } from '../apps/worker-ant-desktop/src/main/core/node-match.js';
import {
  adviceReliabilityOf,
  bottleneckView,
  diskUsageView,
  readNodeEnv,
} from '../apps/worker-ant-desktop/renderer/src/lib/node-view.js';
import { buildNotOlderThan, checkBuildPins, deriveBuildTag, stripKeepingLines } from './lib/rr-pins.js';

const SELF_ROUND = /^rr_(zx_\d{8}(?:_\d+)?)/.exec(path.basename(__filename, '.ts'))?.[1] ?? '';
const ROOT = path.join(__dirname, '..');
const DESKTOP = path.join(ROOT, 'apps/worker-ant-desktop');

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  PASS ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (actual: unknown, expect: unknown, label: string) =>
  ok(JSON.stringify(actual) === JSON.stringify(expect), label, `${JSON.stringify(actual)} vs ${JSON.stringify(expect)}`);

const input = (over: Partial<RoleAdviceInput> = {}): RoleAdviceInput => ({
  online: true,
  currentRole: 'worker',
  weight: 5,
  capacityFreeRatio: 0.6,
  bottleneck: null,
  freeSlots: 2,
  reliability: { successRate: 0.9, avgLatencyMs: 800, samples: 8 },
  ...over,
});

/** 理由一律非空、无空串、且不含 rr 汇总器会误算的失败字形（承 `rr 断言文案不得含 ✗/✓` 的纪律）。 */
function reasonsSound(reasons: string[]): boolean {
  return reasons.length > 0 && reasons.every((r) => r.trim().length > 0 && !r.includes('✗') && !r.includes('✓'));
}

// ═══ A｜建议四态 ═════════════════════════════════════════════════════════════
function sectionA(): void {
  console.log('\n【A】四态建议');

  const offline = suggestNodeRole(input({ online: false }));
  eq(offline.suggested, 'observer', 'A1 ★离线 ⇒ 观察者');
  eq(offline.confidence, 'high', 'A2 离线证据充分 ⇒ 高置信');
  ok(offline.reasons.some((r) => r.includes('离线')) && reasonsSound(offline.reasons), 'A3 理由直说离线');

  const lowCap = suggestNodeRole(input({ capacityFreeRatio: MIN_FREE_RATIO - 0.0001, bottleneck: 'disk', freeSlots: 0 }));
  eq(lowCap.suggested, 'observer', 'A4 ★余力低于下限 ⇒ 观察者');
  ok(lowCap.reasons.some((r) => r.includes(BOTTLENECK_LABEL.disk)), 'A5 理由点出瓶颈是磁盘', lowCap.reasons.join(' / '));

  const ample = suggestNodeRole(input());
  eq(ample.suggested, 'primary', 'A6 ★余力充足且可靠 ⇒ 主节点');
  eq(ample.confidence, 'high', 'A7 两项证据齐 ⇒ 高置信');
  ok(ample.reasons.some((r) => r.includes('成功率')) && reasonsSound(ample.reasons), 'A8 理由含成功率');

  const thinData = suggestNodeRole(input({ capacityFreeRatio: null, freeSlots: null, reliability: null }));
  eq(thinData.suggested, 'worker', 'A9 ★数据不足 ⇒ 工作节点（中性）');
  eq(thinData.confidence, 'low', 'A10 数据不足 ⇒ 低置信');
  ok(thinData.reasons.some((r) => r.includes('数据不足')) && reasonsSound(thinData.reasons), 'A11 理由如实说数据不足');

  const lowRel = suggestNodeRole(input({
    reliability: { successRate: 0.2, avgLatencyMs: 900, samples: MIN_RELIABILITY_SAMPLES },
  }));
  eq(lowRel.suggested, 'observer', 'A12 ★成功率低于阈值 ⇒ 观察者');
  ok(reasonsSound(lowRel.reasons), 'A13 低成功率理由非空');
}

// ═══ B｜与派发同一把尺 ═══════════════════════════════════════════════════════
function sectionB(): void {
  console.log('\n【B】阈值与派发同源');

  const atLimit = suggestNodeRole(input({ capacityFreeRatio: MIN_FREE_RATIO, freeSlots: null, reliability: null }));
  const belowLimit = suggestNodeRole(input({ capacityFreeRatio: MIN_FREE_RATIO - 0.0001, freeSlots: null, reliability: null }));
  eq([atLimit.suggested, belowLimit.suggested], ['worker', 'observer'],
    'B1 ★恰在下限不判死，低于下限才判（边界落在同一阈值）');

  const zeroWeight = suggestNodeRole(input({ weight: 0 }));
  eq(zeroWeight.suggested, 'observer', 'B2 ★权重 0 ⇒ 观察者（与派发硬否决同义）');
  ok(zeroWeight.reasons.some((r) => r.includes('权重')), 'B3 理由点出权重');

  // 样本不足时**不拿成功率判死**（一单失败不等于节点坏了）——同 `MIN_RELIABILITY_SAMPLES`。
  const fewSamples = suggestNodeRole(input({
    reliability: { successRate: 0, avgLatencyMs: 900, samples: MIN_RELIABILITY_SAMPLES - 1 },
  }));
  ok(fewSamples.suggested !== 'observer' || !fewSamples.reasons.some((r) => r.includes('成功率')),
    'B4 样本不足不按成功率判死（仍看余力）', fewSamples.suggested);

  const src = stripKeepingLines(fs.readFileSync(
    path.join(DESKTOP, 'src/main/core/node-role-advice.ts'), 'utf-8')).join('\n');
  ok(src.includes("from './node-match.js'"), 'B5 阈值/样本下限**从 node-match 引**（不另抄）');
  ok(!/const\s+MIN_(FREE_RATIO|SUCCESS_RATE|RELIABILITY_SAMPLES)\s*=/.test(src),
    'B6 反证：建议模块不自己定义这三个阈值');
}

// ═══ C｜只建议、不写库 ═══════════════════════════════════════════════════════
function sectionC(): void {
  console.log('\n【C】只建议，不动手');

  const adviceSrc = stripKeepingLines(fs.readFileSync(
    path.join(DESKTOP, 'src/main/core/node-role-advice.ts'), 'utf-8')).join('\n');
  eq(/export function suggestNodeRole\(input: RoleAdviceInput\)/.test(adviceSrc), true,
    'C1 签名只吃纯输入（无 db / 无 ipc）');
  ok(!/\.prepare\(|\.run\(|INSERT\s+INTO|UPDATE\s+|ipcMain|electron/.test(adviceSrc),
    'C2 ★建议模块无任何写库/写 IPC 痕迹');
  ok(!/from ['"](electron|better-sqlite3)/.test(adviceSrc), 'C3 不引 electron / better-sqlite3');

  const page = stripKeepingLines(fs.readFileSync(
    path.join(DESKTOP, 'renderer/src/pages/PeersPage.tsx'), 'utf-8')).join('\n');
  ok(page.includes('suggestNodeRole({'), 'C4 ★面板按纯函数取建议');
  ok(page.includes('nodesApi.update(node.node_id, { role: suggested })'),
    'C5 ★采纳建议走既有 `nodes:update`（只改角色）');
  ok(/window\.confirm\(/.test(page), 'C6 采纳前有二次确认');
  ok(page.includes('不会自动改'), 'C7 建议卡明说"不会自动改"');
  ok(page.includes('<RoleAdviceCard'), 'C8 建议卡上屏');
}

// ═══ D｜展示投影不抛、不伪造 ═════════════════════════════════════════════════
function sectionD(): void {
  console.log('\n【D】坏值回落与磁盘/瓶颈人话');

  const good = readNodeEnv({
    status: {
      platform: 'darwin', arch: 'arm64', hostname: 'm1',
      os_release: '25.0.0', cpu_model: 'Apple M3', cpu_count: 8,
      disk_free: 300, disk_total: 1000, disk_spare: 0.3,
      capacity_free_ratio: 0.3,
      capacity_basis: { cpu: 0.7, mem: 0.5, slot: 0.4, disk: 0.3, bottleneck: 'disk' },
    },
  } as never);
  eq([good?.os_release, good?.cpu_model, good?.disk_spare], ['25.0.0', 'Apple M3', 0.3], 'D1 新字段原样透传');
  eq(good?.capacity_basis, { cpu: 0.7, mem: 0.5, slot: 0.4, disk: 0.3, bottleneck: 'disk' },
    'D2 四源快照透传');

  const bad = readNodeEnv({
    status: {
      os_release: 123, cpu_model: {}, disk_spare: '0.5',
      capacity_basis: { cpu: 'x', mem: 0.5, slot: null, disk: 0.1, bottleneck: 'gpu' },
    },
  } as never);
  eq([bad?.os_release, bad?.cpu_model, bad?.disk_spare], [null, null, null], 'D3 ★坏类型 ⇒ null（不 stringify）');
  eq(bad?.capacity_basis?.bottleneck, null, 'D4 ★未知瓶颈来源 ⇒ null（不回显英文野值）');
  eq([bad?.capacity_basis?.cpu, bad?.capacity_basis?.mem], [null, 0.5], 'D5 坏源单独回落，好源保留');

  const junk = readNodeEnv({ status: { capacity_basis: 'oops' } } as never);
  eq(junk?.capacity_basis, null, 'D6 非对象 `capacity_basis` ⇒ null（不抛）');

  eq(diskUsageView(good), { label: '700 B / 1000 B（可用 30%）', ratio: 0.3 }, 'D7 ★磁盘给已用/总量（可用%）');
  const legacyDisk = readNodeEnv({ status: { disk_free: 30, disk_total: 100 } } as never);
  eq(diskUsageView(legacyDisk)?.ratio, 0.3, 'D8 旧快照由磁盘字节派生余量');
  const spareOnly = readNodeEnv({ status: { disk_spare: 0.42 } } as never);
  eq(diskUsageView(spareOnly), { label: '可用 42%', ratio: 0.42 }, 'D9 只有余量 ⇒ 只报可用%');
  eq(diskUsageView(null), { label: '未知', ratio: null }, 'D10 无快照 ⇒ 未知（不编 0）');

  eq(bottleneckView(good), '余力瓶颈：磁盘（该项余量 30%）', 'D11 ★瓶颈一句话点明来源与余量');
  eq(bottleneckView(legacyDisk), null, 'D12 旧快照无瓶颈 ⇒ 不说（不编）');

  const row = { successRate: 0.8, latency: 900, successSamples: MIN_RELIABILITY_SAMPLES };
  eq(adviceReliabilityOf(row), { successRate: 0.8, avgLatencyMs: 900, samples: MIN_RELIABILITY_SAMPLES },
    'D13 样本够了 ⇒ 出可靠性画像');
  eq(adviceReliabilityOf({ ...row, successSamples: MIN_RELIABILITY_SAMPLES - 1 }), null,
    'D14 ★样本低于派发下限 ⇒ null（同一把尺）');
  eq(adviceReliabilityOf({ ...row, successRate: null }), null, 'D15 成功率为 null ⇒ null');
  eq(adviceReliabilityOf(null), null, 'D16 无集群行 ⇒ null');
}

// ═══ E｜集群行样本与面板接线 ═════════════════════════════════════════════════
function sectionE(): void {
  console.log('\n【E】集群行样本与接线');

  const cluster = stripKeepingLines(fs.readFileSync(
    path.join(DESKTOP, 'src/main/core/node-cluster.ts'), 'utf-8')).join('\n');
  ok(cluster.includes('successSamples: samples'), 'E1 ★逐行带已收口样本数');
  ok(cluster.includes('successSamples: 0'), 'E2 合成本机行样本 0（不为未知编样本）');

  const page = stripKeepingLines(fs.readFileSync(
    path.join(DESKTOP, 'renderer/src/pages/PeersPage.tsx'), 'utf-8')).join('\n');
  ok(page.includes('adviceReliabilityOf(clusterById.get(id))'), 'E3 ★画像取自集群行（不另取一份台账）');
  ok(page.includes('diskUsageView(env)') && page.includes('bottleneckView(env)'),
    'E4 环境行接磁盘与瓶颈');
  ok(page.includes('env.os_release'), 'E5 环境行接 OS 版本');
  ok(page.includes('env.cpu_model'), 'E6 CPU 型号进标题（空间不足时的详情位）');

  const { tag } = deriveBuildTag(fs.readFileSync(path.join(DESKTOP, 'src/main/core/agent-executor.ts'), 'utf-8'));
  ok(buildNotOlderThan(tag, SELF_ROUND), 'E7 build 标识不早于脚本轮次（方向性派生）', `${tag} vs ${SELF_ROUND}`);
  checkBuildPins(ok, { rootDir: ROOT });
}

sectionA();
sectionB();
sectionC();
sectionD();
sectionE();

console.log(`\n[rr_${SELF_ROUND}_env_role] ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
