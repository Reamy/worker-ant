/**
 * zx_20261107_1 B10a「实·通·信」受控回归 —— 节点双尺与资源感知（孙子·知彼知己 / 管子·仓廪实）。
 *
 * 钉住四件事：
 *   A 双尺合成：能力齐备后，用户权重与实测（成功率/时延/余力/资源）各自把分拉开；
 *   B 权重 0＝不参与协同：匹配硬否决、`beatsLocal` 永不选它、面板/ANS 判据同义；
 *   C 未知不补零：余力/时延/资源缺项按中性计分，理由如实写「未知」；
 *   D 心跳快照 → 资源面：CPU/内存/每核负载各自可空；100% 占用记 0（已知），缺字段记 null（未知）。
 *
 * 纪律：零网络 / 零 electron / 零时钟；断言只做方向性与符号比较，不抄分数幻数。
 */
import fs from 'node:fs';
import path from 'node:path';
import { isDispatchable } from '@worker-ant/shared-types';
import {
  LATENCY_FAST_MS,
  LATENCY_SLOW_MS,
  MIN_FREE_RATIO,
  beatsLocal,
  matchNode,
  resourceScore,
  type NodeMatchProfile,
} from '../apps/worker-ant-desktop/src/main/core/node-match.js';
import {
  planCapabilityDispatch,
  peerProfileOf,
  freeRatioOfStatus,
  resourceProfileOfStatus,
  type CapabilityReadyTask,
} from '../apps/worker-ant-desktop/src/main/core/capability-dispatch.js';
import type { DispatchRequirements } from '../apps/worker-ant-desktop/src/main/core/task-capability.js';
import type { AnsNode } from '@worker-ant/shared-types';
import { buildNotOlderThan, checkBuildPins, deriveBuildTag, stripKeepingLines } from './lib/rr-pins.js';

const SELF_ROUND = /^rr_(zx_\d{8}(?:_\d+)?)/.exec(path.basename(__filename, '.ts'))?.[1] ?? '';
const ROOT = path.join(__dirname, '..');
const DESKTOP = path.join(ROOT, 'apps/worker-ant-desktop/src/main');

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  PASS ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (actual: unknown, expect: unknown, label: string) =>
  ok(JSON.stringify(actual) === JSON.stringify(expect), label, `${JSON.stringify(actual)} vs ${JSON.stringify(expect)}`);

const req = (over: Partial<DispatchRequirements> = {}): DispatchRequirements => ({
  categories: ['code'], intents: [], deviceClasses: [], confidence: 0.6, source: 'rule', ...over,
});

const profile = (over: Partial<NodeMatchProfile> = {}): NodeMatchProfile => ({
  nodeId: 'peer-1', isLocal: false, online: true,
  categories: ['text', 'code'], intents: [], deviceClasses: [],
  freeRatio: 0.8, weight: 5,
  reliability: { successRate: 0.8, avgLatencyMs: 1000, samples: 10 },
  ...over,
});

// ═══ A｜双尺合成：权重与实测各自拉开，不让一项吃掉全部 ═══════════════════════
function sectionA(): void {
  console.log('\n【A】双尺合成（用户权重 × 实测）');

  const lowWeight = matchNode(profile({ weight: 1 }), req());
  const highWeight = matchNode(profile({ weight: 10 }), req());
  ok(lowWeight.veto === null && highWeight.veto === null, 'A1 两台都无可派否决');
  ok(highWeight.score > lowWeight.score, 'A2 ★用户权重更高 ⇒ 分更高',
    `${highWeight.score.toFixed(3)} > ${lowWeight.score.toFixed(3)}`);

  const goodRes = matchNode(profile({ resources: { cpuSpare: 0.9, memSpare: 0.9, loadPerCore: 0.1 } }), req());
  const badRes = matchNode(profile({ resources: { cpuSpare: 0.1, memSpare: 0.1, loadPerCore: 0.9 } }), req());
  eq([goodRes.veto, badRes.veto], [null, null], 'A3 资源差也**不**硬否决（只降分）');
  ok(goodRes.score > badRes.score, 'A4 ★资源空闲 ⇒ 分更高',
    `${goodRes.score.toFixed(3)} > ${badRes.score.toFixed(3)}`);

  const fast = matchNode(profile({ reliability: { successRate: 0.8, avgLatencyMs: LATENCY_FAST_MS, samples: 10 } }), req());
  const slow = matchNode(profile({ reliability: { successRate: 0.8, avgLatencyMs: LATENCY_SLOW_MS, samples: 10 } }), req());
  ok(fast.score > slow.score, 'A5 ★时延更低 ⇒ 分更高', `${fast.score.toFixed(3)} > ${slow.score.toFixed(3)}`);

  const reliable = matchNode(profile({ reliability: { successRate: 1, avgLatencyMs: 1000, samples: 10 } }), req());
  const flaky = matchNode(profile({ reliability: { successRate: 0.4, avgLatencyMs: 1000, samples: 10 } }), req());
  ok(reliable.score > flaky.score, 'A6 ★成功率更高 ⇒ 分更高', `${reliable.score.toFixed(3)} > ${flaky.score.toFixed(3)}`);

  ok(resourceScore({ cpuSpare: 0.8, memSpare: 0.4, loadPerCore: 0.3 }) === (0.8 + 0.4 + 0.7) / 3,
    'A7 资源分＝已知项均值（负载取 1−每核负载）');
  eq(resourceScore(null), null, 'A8 无资源面 ⇒ null（交给中性计分）');
  eq(resourceScore({ cpuSpare: null, memSpare: null, loadPerCore: null }), null, 'A9 全部未知 ⇒ null（不是 0）');
}

// ═══ B｜权重 0＝不参与协同 ═══════════════════════════════════════════════════
function sectionB(): void {
  console.log('\n【B】权重 0＝用户关闭参与');

  const zero = matchNode(profile({ weight: 0 }), req());
  eq(zero.veto, 'weight-zero', 'B1 ★权重 0 ⇒ 硬否决');
  eq(zero.score, 0, 'B2 ★否决时分数归零');
  ok(zero.reason.includes('不参与协同'), 'B3 理由直说「不参与协同」', zero.reason);

  const strongZero = matchNode(profile({
    weight: 0, freeRatio: 1, resources: { cpuSpare: 1, memSpare: 1, loadPerCore: 0 },
    reliability: { successRate: 1, avgLatencyMs: 100, samples: 10 },
  }), req());
  ok(!beatsLocal(strongZero, matchNode(profile({ isLocal: true, weight: 1 }), req()), 0.12),
    'B4 ★权重 0 的机器再强也不选（不派给已退出者）');

  const tiny = matchNode(profile({ weight: 0.5 }), req());
  eq(tiny.veto, null, 'B5 正的小权重（0.5）不排除，只是倍率低（不误伤）');

  eq(isDispatchable({ role: 'worker', participate: true, weight: 0 }), false, 'B6 面板/编排判据：权重 0 ⇒ 不派单');
  eq(isDispatchable({ role: 'worker', participate: true }), true, 'B7 未声明权重按旧形状放行（兼容）');
  eq(isDispatchable({ role: 'worker', participate: true, weight: 3 }), true, 'B8 正权重照常可派');
  eq(isDispatchable({ role: 'observer', participate: true, weight: 9 }), false, 'B9 观察者即便高权重仍不承接');

  // 决策器：只给一台权重 0 的强对端 ⇒ 不外派。
  const task: CapabilityReadyTask = { id: 't1', title: 't1', requirements: req() };
  const decided = planCapabilityDispatch({
    mode: 'capability',
    ready: [task],
    local: profile({ nodeId: 'local', isLocal: true, weight: 1, freeRatio: 0.2 }),
    peers: [profile({ nodeId: 'peer-zero', weight: 0, freeRatio: 1 })],
    attempts: new Map(),
    cooldownUntil: new Map(),
    now: 0,
  });
  eq(decided.length, 0, 'B10 ★能力决策器不把活派给权重 0 的对端');
}

// ═══ C｜未知不补零 ═══════════════════════════════════════════════════════════
function sectionC(): void {
  console.log('\n【C】未知按中性计，不拿 0 冒充满载/最慢');

  const noRes = matchNode(profile({ resources: undefined }), req());
  const nullRes = matchNode(profile({ resources: { cpuSpare: null, memSpare: null, loadPerCore: null } }), req());
  const midRes = matchNode(profile({ resources: { cpuSpare: 0.5, memSpare: 0.5, loadPerCore: 0.5 } }), req());
  eq(noRes.score, nullRes.score, 'C1 资源缺省与显式全空同分（都走中性）');
  eq(noRes.score, midRes.score, 'C2 中性 0.5 与"刚好半闲"同分（未知不装高也不压死）');
  ok(noRes.reason.includes('资源:未知') && nullRes.reason.includes('资源:未知'), 'C3 ★理由如实写「资源:未知」');

  const midpoint = (LATENCY_FAST_MS + LATENCY_SLOW_MS) / 2;
  const noLatency = matchNode(profile({ reliability: { successRate: 0.8, avgLatencyMs: null, samples: 10 } }), req());
  const midLatency = matchNode(profile({ reliability: { successRate: 0.8, avgLatencyMs: midpoint, samples: 10 } }), req());
  eq(noLatency.score, midLatency.score, 'C4 时延未知＝中位时延（同一把中性尺）');
  ok(noLatency.reason.includes('时延:未知'), 'C5 ★理由如实写「时延:未知」');

  const noRel = matchNode(profile({ reliability: null }), req());
  ok(noRel.veto === null && noRel.reason.includes('成功率:未知'), 'C6 无历史账 ⇒ 不否决、理由如实');
  ok(noRel.reason.includes('时延:未知'), 'C7 无历史账 ⇒ 时延也如实未知');

  const onlyCpu = matchNode(profile({ resources: { cpuSpare: 0.8, memSpare: null, loadPerCore: null } }), req());
  ok(onlyCpu.reason.includes('资源:80%'), 'C8 只知 CPU ⇒ 只按已知项计（80%）', onlyCpu.reason);

  const freeUnknown = matchNode(profile({ freeRatio: null }), req());
  ok(freeUnknown.veto === null && freeUnknown.reason.includes('余力:未知'),
    'C9 余力未知 ⇒ 不否决、理由如实（旧口径保持）');
  eq(matchNode(profile({ freeRatio: MIN_FREE_RATIO - 0.01 }), req()).veto?.split(':')[0], 'free-too-low',
    'C10 余力已知且过低 ⇒ 仍硬否决（未知与过低分开）');
}

// ═══ D｜心跳快照 → 资源面 ════════════════════════════════════════════════════
function sectionD(): void {
  console.log('\n【D】心跳快照 → 资源面（可空、不补零）');

  eq(resourceProfileOfStatus({
    cpu_usage_percent: 25, total_mem: 1000, free_mem: 400, load_avg1: 2, cpu_count: 4,
  }), { cpuSpare: 0.75, memSpare: 0.4, loadPerCore: 0.5, diskSpare: null }, 'D1 四项齐备 ⇒ 逐项派生（磁盘无数据留 null）');
  eq(resourceProfileOfStatus({ disk_spare: 0.2 }).diskSpare, 0.2, 'D1b 新心跳直读 disk_spare');
  eq(resourceProfileOfStatus({ disk_free: 30, disk_total: 100 }).diskSpare, 0.3, 'D1c 旧心跳由 disk_free/disk_total 派生');

  eq(resourceProfileOfStatus({}), { cpuSpare: null, memSpare: null, loadPerCore: null, diskSpare: null },
    'D2 空快照 ⇒ 全未知（不补零）');
  eq(resourceProfileOfStatus(null), { cpuSpare: null, memSpare: null, loadPerCore: null, diskSpare: null },
    'D3 从未心跳 ⇒ 全未知');

  eq(resourceProfileOfStatus({ cpu_usage_percent: 100 }).cpuSpare, 0, 'D4 CPU 100% ⇒ 0（已知满载，不是未知）');
  eq(resourceProfileOfStatus({ cpu_usage_percent: 0 }).cpuSpare, 1, 'D5 CPU 0% ⇒ 1（已知空闲）');

  eq(resourceProfileOfStatus({ load_avg1: null, cpu_count: 4 }).loadPerCore, null,
    'D6 Windows 无 loadavg（null）⇒ 每核负载未知');
  eq(resourceProfileOfStatus({ load_avg1: 2, cpu_count: 0 }).loadPerCore, null,
    'D7 核数为 0/缺失 ⇒ 每核负载未知（不做除零）');
  eq(resourceProfileOfStatus({ total_mem: 0, free_mem: 0 }).memSpare, null,
    'D8 总内存为 0 ⇒ 内存余量未知');
  eq(resourceProfileOfStatus({ cpu_usage_percent: '25' as unknown as number }).cpuSpare, null,
    'D9 坏类型 ⇒ 未知（不 Number() 强转）');

  eq(freeRatioOfStatus({ machine_limit: 4, free_slots: 1 }), 0.25, 'D10 余力口径未被资源面改写');
}

// ═══ E｜台账行 → 画像 ════════════════════════════════════════════════════════
function sectionE(): void {
  console.log('\n【E】台账行 → 匹配画像');
  const node = {
    node_id: 'peer-1', name: 'peer', api_key_prefix: 'ak', resource_group: 'g',
    platform: 'darwin', role: 'worker', weight: 7, participate: true, capabilities: [],
    card: { categories: ['code'], intents: [{ id: 'home.comfort', label: '舒适' }], device_categories: [{ class: 'light' }] },
    status: { machine_limit: 4, free_slots: 2, cpu_usage_percent: 50, total_mem: 1000, free_mem: 500, load_avg1: 1, cpu_count: 2 },
    enrolled_at: '2026-11-07 00:00:00', last_seen_at: new Date(0).toISOString(),
  } as unknown as AnsNode;

  const p = peerProfileOf(node, 200_000, { successRate: 0.9, avgLatencyMs: 800, samples: 6 });
  eq(p.weight, 7, 'E1 权重取台账值');
  eq(p.resources, { cpuSpare: 0.5, memSpare: 0.5, loadPerCore: 0.5, diskSpare: null }, 'E2 资源面取心跳快照（磁盘无数据留 null）');
  eq(p.categories, ['code'], 'E3 类目取卡');
  eq(p.freeRatio, 0.5, 'E4 余力取心跳');
  eq(p.online, false, 'E5 旧心跳按离线（判活同源）');

  const zeroNode = {
    ...node, weight: 0, last_seen_at: new Date(200_000).toISOString(),
  } as unknown as AnsNode;
  const zeroProfile = peerProfileOf(zeroNode, 200_000, null);
  eq(matchNode(zeroProfile, req()).veto, 'weight-zero', 'E6 ★台账权重 0 ⇒ 画像直接不可派');
  ok(matchNode(peerProfileOf({ ...node, last_seen_at: new Date(200_000).toISOString() } as unknown as AnsNode, 200_000, null), req()).veto === null,
    'E7 同函数下可派行不误伤');
}

// ═══ F｜接线：本机权重、资源面、ANS 与共享判据同义 ═══════════════════════════
function sectionF(): void {
  console.log('\n【F】接线与词表');

  const orch = stripKeepingLines(fs.readFileSync(path.join(DESKTOP, 'core/orchestrator.ts'), 'utf-8')).join('\n');
  ok(orch.includes('readLocalWeight(db)'), 'F1 ★本机画像读用户权重（不再硬编码 5）');
  ok(orch.includes('NODE_SETTING_KEYS.weight'), 'F2 权重键走单源常量');

  const cap = stripKeepingLines(fs.readFileSync(path.join(DESKTOP, 'core/capability-dispatch.ts'), 'utf-8')).join('\n');
  ok(cap.includes('resourceProfileOfStatus(node.status)'), 'F3 ★对端画像接心跳资源面');
  ok(cap.includes("from './node-match.js'"), 'F4 画像与匹配同一模块（不另造尺）');

  const ans = stripKeepingLines(fs.readFileSync(path.join(ROOT, 'apps/ans-server/src/routes/nodes.ts'), 'utf-8')).join('\n');
  ok(ans.includes('AND weight > 0'), 'F5 ★ANS 选目标排除权重 0（与面板/编排同义）');

  const match = stripKeepingLines(fs.readFileSync(path.join(DESKTOP, 'core/node-match.ts'), 'utf-8')).join('\n');
  ok(match.includes("setVeto('weight-zero')"), 'F6 匹配层权重 0 硬否决在册');

  // 本轮构建标识与脚本同源（方向性：不写死轮次字面量）。
  const { tag } = deriveBuildTag(fs.readFileSync(path.join(DESKTOP, 'core/agent-executor.ts'), 'utf-8'));
  ok(buildNotOlderThan(tag, SELF_ROUND), 'F7 build 标识不早于脚本轮次（方向性派生）', `${tag} vs ${SELF_ROUND}`);
  checkBuildPins(ok, { rootDir: ROOT });
}

sectionA();
sectionB();
sectionC();
sectionD();
sectionE();
sectionF();

console.log(`\n[rr_${SELF_ROUND}_dispatch] ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
