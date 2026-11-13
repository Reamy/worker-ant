/**
 * zx_20261107_1「实·通·信」总闸受控回归。
 *
 * 本脚本只钉**本轮契约**：build 标识单一真源、方案在册、复跑脚本在册、产物同值。
 * 各批次的细项断言分别落在同前缀的 `rr_zx_20261107_1_*.ts` 中，本脚本不重复。
 *
 * 纪律：轮次标识由 `path.basename(__filename)` 派生，不写「只为下一轮」的字面量。
 */
import fs from 'node:fs';
import path from 'node:path';
import { checkBuildPins, deriveBuildTag, ROUND_RE } from './lib/rr-pins.js';

const SELF_ROUND = /^rr_(zx_\d{8}(?:_\d+)?)/.exec(path.basename(__filename, '.ts'))?.[1] ?? '';
const ROOT = path.join(__dirname, '..');

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  PASS ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}

// A 方案在册（P3 的同一真源，但这里独立给出一条可读断言）
ok(fs.existsSync(path.join(ROOT, 'plans/improve', `${SELF_ROUND}.md`)), `本轮方案在册：plans/improve/${SELF_ROUND}.md`);

// B 构建标识不早于脚本自身轮次（方向性，由载体自身派生；当前真源的同值/在册由 P1–P6 核对）
const srcText = fs.readFileSync(path.join(ROOT, 'apps/worker-ant-desktop/src/main/core/agent-executor.ts'), 'utf-8');
const { tag } = deriveBuildTag(srcText);
const roundDate = (t: string): number => Number(t.slice(3).split('_')[0]);
ok(
  ROUND_RE.test(tag) && roundDate(tag) >= roundDate(SELF_ROUND),
  'build 标识不早于本脚本轮次（方向性派生）',
  `${tag} vs ${SELF_ROUND}`,
);

// C build 钉 P1–P6（dist 已构建时一并核对产物）
checkBuildPins(ok, { rootDir: ROOT });

// D 本批已落地的细项脚本在册（逐批追加；不写死数量，按名单枚举）
const SIBLINGS = [
  'rr_zx_20261107_1_device_lan.ts',
  'rr_zx_20261107_1_device_cloud.ts',
  'rr_zx_20261107_1_terminal.ts',
  'rr_zx_20261107_1_knowledge.ts',
  'rr_zx_20261107_1_injection.ts',
  'rr_zx_20261107_1_preflight.ts',
  'rr_zx_20261107_1_model.ts',
  'rr_zx_20261107_1_dispatch.ts',
  'rr_zx_20261107_1_settings.ts',
];
for (const f of SIBLINGS) {
  ok(fs.existsSync(path.join(ROOT, 'scripts', f)), `细项复跑脚本在册：scripts/${f}`);
}

console.log(`\n[rr_${SELF_ROUND}] ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
