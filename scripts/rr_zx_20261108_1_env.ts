/**
 * zx_20261108_1 B1「境」受控回归 —— 环境真感知：四源取严、磁盘入资源分、瓶颈可解释。
 *
 * A 四源取严（纯函数 `deriveCapacity`）：磁盘最紧 ⇒ 取磁盘；磁盘未知 ⇒ 退回三源（旧行为反证）；
 *   全未知 ⇒ null；并列按 `cpu → mem → slot → disk` 定序；非有限值不参与。
 * B 采集快照：`os_release` / `cpu_model` / `disk_spare` / `capacity_basis` 真在；瓶颈值 = 比率值。
 * C `resourceScore`：磁盘已知参与平均；磁盘未知不惩罚（与无该项全等）。
 * D `resourceProfileOfStatus`：`disk_spare` 直读 / `disk_free+disk_total` 派生 / 全无 ⇒ null。
 * E ANS `parseCapacity`：新形状解析瓶颈与四源；旧形状逐键不变（深比较）；理由含瓶颈词；未知不编。
 * F 接线（剥注释后的代码）：orchestrator 用同一派生、本机不再 `resources: null`、启动传 dataDir。
 *
 * 纪律：零网络 / 零 electron；夹具自建 DDL；不以真实墙钟为判据；断言文案不含失败字形。
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

import {
  collectNodeEnv,
  deriveCapacity,
  type NodeCapacityBasis,
} from '../apps/worker-ant-desktop/src/main/core/node-heartbeat.js';
import type { NodeSettingDb } from '../apps/worker-ant-desktop/src/main/core/node-identity.js';
import type { CpuSampler } from '../apps/worker-ant-desktop/src/main/core/cpu-sampler.js';
import { resourceScore } from '../apps/worker-ant-desktop/src/main/core/node-match.js';
import { resourceProfileOfStatus } from '../apps/worker-ant-desktop/src/main/core/capability-dispatch.js';
import {
  describeNode,
  parseCapacity,
  rankDispatchCandidates,
  type RankableNode,
} from '../apps/ans-server/src/routes/node-ranking.js';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';

const SELF_ROUND = /^rr_(zx_\d{8}(?:_\d+)?)/.exec(path.basename(__filename, '.ts'))?.[1] ?? '';
const ROOT = path.join(__dirname, '..');

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  PASS ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (actual: unknown, expect: unknown, label: string) =>
  ok(JSON.stringify(actual) === JSON.stringify(expect), label, `${JSON.stringify(actual)} vs ${JSON.stringify(expect)}`);

/** 最小 wa_settings/wa_tasks/wa_jobs 夹具（字段形状照抄生产；计数的表必须有）。 */
function makeDb(): NodeSettingDb {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, status TEXT);
    CREATE TABLE wa_jobs (id TEXT PRIMARY KEY, status TEXT);
  `);
  db.prepare("INSERT INTO wa_settings (key, value) VALUES ('machine_max_concurrency', '4')").run();
  return db as unknown as NodeSettingDb;
}

const fakeSampler = (percent: number | null): CpuSampler => ({
  sample: () => ({ percent, at: '2026-11-08T00:00:00.000Z' }),
});

function sectionA(): void {
  console.log('\n【A】四源取严');
  const tightDisk = deriveCapacity({ cpu: 0.9, mem: 0.8, slot: 0.7, disk: 0.12 });
  ok(tightDisk.freeRatio === 0.12 && tightDisk.basis.bottleneck === 'disk', 'A-1 磁盘最紧 ⇒ 余力取磁盘', JSON.stringify(tightDisk));
  ok(tightDisk.basis.disk === 0.12, 'A-2 瓶颈源的值与比率同值');

  const noDisk = deriveCapacity({ cpu: 0.9, mem: 0.8, slot: 0.7, disk: null });
  ok(noDisk.freeRatio === 0.7 && noDisk.basis.bottleneck === 'slot', 'A-3 磁盘未知 ⇒ 退回三源（旧行为不变）', JSON.stringify(noDisk));
  eq(deriveCapacity({ cpu: 0.9, mem: 0.8, slot: 0.7, disk: null }).freeRatio, deriveCapacity({ cpu: 0.9, mem: 0.8, slot: 0.7, disk: 0.99 }).freeRatio, 'A-4 磁盘宽裕时不改变旧三源结果');

  const allUnknown = deriveCapacity({ cpu: null, mem: null, slot: null, disk: null });
  ok(allUnknown.freeRatio === null && allUnknown.basis.bottleneck === null, 'A-5 全未知 ⇒ null（不谎报空闲）');

  const tie = deriveCapacity({ cpu: 0.5, mem: 0.5, slot: 0.5, disk: 0.5 });
  ok(tie.basis.bottleneck === 'cpu', 'A-6 并列按 cpu → mem → slot → disk 定序');
  eq(tie.freeRatio, 0.5, 'A-7 并列不影响数值');

  const dirty = deriveCapacity({ cpu: Number.NaN, mem: 0.4, slot: null, disk: null });
  ok(dirty.freeRatio === 0.4 && dirty.basis.cpu === null && dirty.basis.bottleneck === 'mem', 'A-8 非有限值按未知跳过', JSON.stringify(dirty));
}

function sectionB(): void {
  console.log('\n【B】采集快照真含增量字段');
  const env = collectNodeEnv(makeDb(), { cpuSampler: fakeSampler(40), dataDir: ROOT, cpus: 4 });
  ok(typeof env.os_release === 'string' && env.os_release !== '', 'B-1 os_release 如实采集', String(env.os_release));
  ok(env.cpu_model === null || (typeof env.cpu_model === 'string' && env.cpu_model !== ''), 'B-2 cpu_model 有值或如实 null', String(env.cpu_model));
  ok(env.disk_free != null && env.disk_total != null && env.disk_total > 0, 'B-3 夹具目录有卷信息（磁盘余量可算）');
  if (env.disk_free != null && env.disk_total != null && env.disk_total > 0) {
    ok(
      env.disk_spare != null && Math.abs(env.disk_spare - env.disk_free / env.disk_total) < 1e-9,
      'B-4 disk_spare = 可用 / 总量',
      `${env.disk_free}/${env.disk_total} => ${env.disk_spare}`,
    );
  }
  const basis: NodeCapacityBasis = env.capacity_basis;
  ok(basis != null && typeof basis === 'object', 'B-5 capacity_basis 随快照上报');
  ok(
    basis.bottleneck != null && basis[basis.bottleneck] === env.capacity_free_ratio,
    'B-6 瓶颈源的值 = capacity_free_ratio（解释与数值同源）',
    `${basis.bottleneck} ${String(basis[basis.bottleneck])} vs ${String(env.capacity_free_ratio)}`,
  );

  const missingDisk = collectNodeEnv(makeDb(), {
    cpuSampler: fakeSampler(40),
    dataDir: path.join(ROOT, '__no_such_volume__'),
    cpus: 4,
  });
  ok(missingDisk.disk_spare === null && missingDisk.disk_free === null, 'B-7 卷信息取不到 ⇒ 磁盘留 null（不谎报 0）');
  ok(missingDisk.capacity_basis.bottleneck !== 'disk', 'B-8 磁盘未知时不可能是瓶颈');
  const spares = [missingDisk.capacity_basis.cpu, missingDisk.capacity_basis.mem, missingDisk.capacity_basis.slot]
    .filter((v): v is number => v != null);
  if (spares.length > 0) {
    ok(
      Math.abs(missingDisk.capacity_free_ratio! - Math.min(...spares)) < 1e-9,
      'B-9 磁盘未知 ⇒ 比率退回三源最小值（与 A-3 同口径）',
      `${missingDisk.capacity_free_ratio} vs ${Math.min(...spares)}`,
    );
  }
}

function sectionC(): void {
  console.log('\n【C】资源分纳入磁盘');
  const noDisk = resourceScore({ cpuSpare: 0.9, memSpare: 0.9, loadPerCore: 0, diskSpare: null });
  const noKey = resourceScore({ cpuSpare: 0.9, memSpare: 0.9, loadPerCore: 0 });
  eq(noDisk, noKey, 'C-1 磁盘未知不惩罚（与缺该项全等）');
  const lowDisk = resourceScore({ cpuSpare: 0.9, memSpare: 0.9, loadPerCore: 0, diskSpare: 0.1 });
  ok(lowDisk != null && noDisk != null && lowDisk < noDisk, 'C-2 磁盘余量低 ⇒ 资源分如实下降', `${lowDisk} < ${noDisk}`);
  const onlyDisk = resourceScore({ cpuSpare: null, memSpare: null, loadPerCore: null, diskSpare: 0.25 });
  eq(onlyDisk, 0.25, 'C-3 只有磁盘已知时只按磁盘计');
  eq(resourceScore({ cpuSpare: null, memSpare: null, loadPerCore: null, diskSpare: null }), null, 'C-4 全未知 ⇒ null（调用方按中性）');
}

function sectionD(): void {
  console.log('\n【D】对端画像可派生磁盘余量');
  eq(resourceProfileOfStatus({ disk_spare: 0.3 }).diskSpare, 0.3, 'D-1 新心跳直读 disk_spare');
  eq(resourceProfileOfStatus({ disk_free: 30, disk_total: 100 }).diskSpare, 0.3, 'D-2 旧心跳由 disk_free/disk_total 派生');
  eq(resourceProfileOfStatus({ disk_free: 30 }).diskSpare, null, 'D-3 只有一个数 ⇒ null（不猜总量）');
  eq(resourceProfileOfStatus({}).diskSpare, null, 'D-4 无磁盘字段 ⇒ null');
  eq(resourceProfileOfStatus({ disk_spare: 1.8 }).diskSpare, 1, 'D-5 越界按边界收（与 cpu/mem 同口径）');
}

function sectionE(): void {
  console.log('\n【E】ANS 解释：瓶颈可读且不改排序');
  const newStatus = JSON.stringify({
    capacity_free_ratio: 0.05,
    free_slots: 1,
    disk_free: Math.round(3.2 * 1024 ** 3),
    disk_total: 120 * 1024 ** 3,
    capacity_basis: { cpu: 0.7, mem: 0.5, slot: 0.9, disk: 0.05, bottleneck: 'disk' },
  });
  const parsed = parseCapacity(newStatus);
  eq(parsed.bottleneck, 'disk', 'E-1 瓶颈解析为磁盘');
  eq(parsed.basis?.disk, 0.05, 'E-2 四源快照解析');
  ok(parsed.diskFree != null && parsed.diskTotal != null, 'E-3 磁盘字节随解析带出');

  const snap = describeNode({ node_id: 'n1', weight: 2, status_json: newStatus, last_seen_at: null });
  ok(snap.reason.includes('瓶颈：磁盘'), 'E-4 理由含瓶颈词', snap.reason);
  ok(snap.reason.includes('可用 3.2GB / 120.0GB'), 'E-5 磁盘瓶颈附可用/总量', snap.reason);

  const legacy = parseCapacity(JSON.stringify({ capacity_free_ratio: 0.5, free_slots: 2 }));
  eq(legacy, { ratio: 0.5, freeSlots: 2 }, 'E-6 旧形状逐键不变（无新增键）');
  const legacySnap = describeNode({
    node_id: 'n2',
    weight: 1,
    status_json: JSON.stringify({ capacity_free_ratio: 0.5, free_slots: 2 }),
    last_seen_at: null,
  });
  ok(!legacySnap.reason.includes('瓶颈'), 'E-7 无瓶颈数据时理由不编', legacySnap.reason);

  const badBottleneck = parseCapacity(JSON.stringify({
    capacity_free_ratio: 0.5,
    capacity_basis: { cpu: 0.5, mem: null, slot: null, disk: null, bottleneck: 'gpu' },
  }));
  ok(!('bottleneck' in badBottleneck), 'E-8 坏瓶颈值不解析（不猜）');
  ok(badBottleneck.basis?.cpu === 0.5, 'E-9 坏瓶颈不影响四源快照本身');

  const a: RankableNode = { node_id: 'a', weight: 1, status_json: newStatus, last_seen_at: null };
  const b: RankableNode = {
    node_id: 'b',
    weight: 10,
    status_json: JSON.stringify({ capacity_free_ratio: 0.6 }),
    last_seen_at: null,
  };
  const ranked = rankDispatchCandidates([a, b]);
  eq(ranked.map((c) => c.nodeId), ['b', 'a'], 'E-10 瓶颈字段不参与排序（仍按 weight × ratio）');
}

function sectionF(): void {
  console.log('\n【F】接线：同一派生、本机画像、启动传 dataDir');
  const orch = stripKeepingLines(fs.readFileSync(
    path.join(ROOT, 'apps/worker-ant-desktop/src/main/core/orchestrator.ts'),
    'utf-8',
  )).join('\n');
  ok(/collectNodeEnv\(/.test(orch), 'F-1 orchestrator 采集本机环境');
  ok(/resourceProfileOfStatus\(/.test(orch), 'F-2 本机与对端同引同一资源面派生');
  ok(!/resources:\s*null/.test(orch), 'F-3 本机画像不再恒为 null');

  const hb = stripKeepingLines(fs.readFileSync(
    path.join(ROOT, 'apps/worker-ant-desktop/src/main/core/node-heartbeat.ts'),
    'utf-8',
  )).join('\n');
  ok(/deriveCapacity\(\{ cpu: cpuSpare, mem: memSpare, slot: slotSpare, disk: diskSpare \}\)/.test(hb), 'F-4 心跳比率走四源纯函数（非另写一份）');

  const main = stripKeepingLines(fs.readFileSync(
    path.join(ROOT, 'apps/worker-ant-desktop/src/main/index.ts'),
    'utf-8',
  )).join('\n');
  ok(/driveOrchestration\(driverDb,\s*\{[\s\S]{0,500}?dataDir,/.test(main), 'F-5 启动接线把真实数据目录传给编排');

  ok(fs.existsSync(path.join(ROOT, 'plans/improve', `${SELF_ROUND}.md`)), `F-6 方案在册：plans/improve/${SELF_ROUND}.md`);
  checkBuildPins(ok);
}

sectionA();
sectionB();
sectionC();
sectionD();
sectionE();
sectionF();

console.log(`\n[rr_${SELF_ROUND}_env] ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
