/**
 * zx_20261106_3「协」B2 受控回归 —— 节点匹配分：同一把尺、硬否决、margin 两侧。
 *
 * A 打分：能力面全具备时由可靠性/余力/权重拉开差距；本机与他机同一函数同分。
 * B 硬否决：离线 / 缺类目 / 缺意图 / 缺品类 / 余力过低 / 历史太低（样本够）逐项。
 * C 两只标本：可靠性样本不足不据一票否决；余力未知按中性计不否决。
 * D margin：差一点点不派；差足够多才派；本机被否决时对端可派即可。
 *
 * 纪律：零网络 / 零 electron / 零时钟；断言只做方向性与符号比较，不抄分数幻数。
 */
import path from 'node:path';
import {
  MIN_FREE_RATIO,
  beatsLocal,
  matchNode,
  type NodeMatchProfile,
} from '../apps/worker-ant-desktop/src/main/core/node-match.js';
import type { DispatchRequirements } from '../apps/worker-ant-desktop/src/main/core/task-capability.js';
import { checkBuildPins } from './lib/rr-pins.js';

const SELF_ROUND = /^rr_(zx_\d{8}(?:_\d+)?)/.exec(path.basename(__filename, '.ts'))?.[1] ?? '';

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
  nodeId: 'n1', isLocal: false, online: true,
  categories: ['text', 'code'], intents: ['home.comfort'], deviceClasses: ['light'],
  freeRatio: 0.8, weight: 5, reliability: { successRate: 0.8, avgLatencyMs: 1200, samples: 10 },
  ...over,
});

function sectionA(): void {
  console.log('\n【A】打分：能力齐备后由余力/权重/可靠性拉开');
  const weak = matchNode(profile({ freeRatio: 0.2, weight: 1, reliability: { successRate: 0.5, avgLatencyMs: 3000, samples: 10 } }), req());
  const strong = matchNode(profile({ freeRatio: 1, weight: 10, reliability: { successRate: 1, avgLatencyMs: 500, samples: 10 } }), req());
  ok(weak.veto === null && strong.veto === null, 'A-1 两台都无可派否决');
  ok(strong.score > weak.score, 'A-2 强机分数更高', `${strong.score.toFixed(3)} > ${weak.score.toFixed(3)}`);
  ok(strong.score <= 1 && weak.score >= 0, 'A-3 分数在 0..1');
  const asLocal = matchNode(profile({ isLocal: true }), req());
  const asPeer = matchNode(profile({ isLocal: false }), req());
  eq(asLocal.score, asPeer.score, 'A-4 本机与他机用同一函数得同一分');
  ok(asLocal.reason.includes('余力') && strong.reason.includes('成功率'), 'A-5 理由含可读维度');
}

function sectionB(): void {
  console.log('\n【B】硬否决：缺一即不可派');
  eq(matchNode(profile({ online: false }), req()).veto, 'offline', 'B-1 离线');
  eq(matchNode(profile({ categories: ['text'] }), req()).veto, 'missing-category:code', 'B-2 缺主类目');
  eq(matchNode(profile(), req({ intents: ['home.comfort', 'home.leave'] })).veto, 'missing-intent:home.leave', 'B-3 缺要求意图');
  eq(matchNode(profile({ deviceClasses: [] }), req({ deviceClasses: ['aircon'] })).veto, 'missing-device:aircon', 'B-4 缺要求品类');
  ok(matchNode(profile({ freeRatio: MIN_FREE_RATIO - 0.01 }), req()).veto?.startsWith('free-too-low') === true, 'B-5 余力低于阈值');
  eq(matchNode(profile({ reliability: { successRate: 0.2, avgLatencyMs: null, samples: 10 } }), req()).veto?.split(':')[0], 'low-reliability', 'B-6 样本够且成功率过低');
  const vetoed = matchNode(profile({ online: false }), req());
  ok(vetoed.score === 0 && vetoed.reason.startsWith('不可派：'), 'B-7 否决时分数归零且理由直说');
}

function sectionC(): void {
  console.log('\n【C】两只标本：不足据否决 / 未知不装高');
  ok(matchNode(profile({ reliability: { successRate: 0.2, avgLatencyMs: null, samples: 2 } }), req()).veto === null,
    'C-1 可靠性样本只有 2 条 ⇒ 不据一票否决');
  const unknownFree = matchNode(profile({ freeRatio: null }), req());
  ok(unknownFree.veto === null && unknownFree.reason.includes('余力:未知'), 'C-2 余力未知 ⇒ 中性计、不否决、理由如实');
}

function sectionD(): void {
  console.log('\n【D】margin：差一点点不派，差足够多才派');
  const local = matchNode(profile({ isLocal: true, freeRatio: 0.5, weight: 5, reliability: { successRate: 0.8, avgLatencyMs: null, samples: 10 } }), req());
  const close = matchNode(profile({ freeRatio: 0.6, weight: 5, reliability: { successRate: 0.8, avgLatencyMs: null, samples: 10 } }), req());
  const far = matchNode(profile({ freeRatio: 1, weight: 10, reliability: { successRate: 1, avgLatencyMs: null, samples: 10 } }), req());
  ok(far.score > local.score, 'D-0 强机分数确实更高');
  ok(!beatsLocal(close, local, 0.12), 'D-1 只强一点点（<0.12）不派', `diff=${(close.score - local.score).toFixed(3)}`);
  ok(beatsLocal(far, local, 0.12), 'D-2 差足够多（>0.12）才派', `diff=${(far.score - local.score).toFixed(3)}`);
  const localVetoed = matchNode(profile({ isLocal: true, freeRatio: 0.05 }), req());
  ok(localVetoed.veto !== null, 'D-3 本机余力过低被否决');
  ok(beatsLocal(far, localVetoed, 0.12), 'D-4 本机不可派时，对端可派即可（margin 不再适用）');
  const peerVetoed = matchNode(profile({ online: false }), req());
  ok(!beatsLocal(peerVetoed, local, 0.12), 'D-5 对端被否决 ⇒ 永不派');
}

function sectionE(): void {
  console.log('\n【E】静态钉：build 真源 / 方案与脚本在册');
  checkBuildPins(ok);
}

sectionA();
sectionB();
sectionC();
sectionD();
sectionE();

console.log(`\n${fail === 0 ? 'OK' : 'FAIL'} rr_${SELF_ROUND}: ${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
