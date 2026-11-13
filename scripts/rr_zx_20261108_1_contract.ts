/**
 * zx_20261108_1 B0「境·识·忆·诚」受控回归——契约前置。
 *
 * 三问：
 *   A 构建标识：源码唯一真源＝本脚本轮次（由文件名派生），且 P1–P6 全过；
 *   B 数据目录覆盖：`WA_DATA_DIR` **只在 dev 分支**被读，生产分支没有旁路；
 *   C 多实例覆盖：`WA_ALLOW_MULTI_INSTANCE=1` **只在 dev 分支**生效，生产恒走单实例锁。
 *
 * 纪律：轮次值由 `path.basename(__filename)` 派生后做方向性比较，不写"只为下一轮"的字面量；
 * 断言文案不含失败字形。
 */
import fs from 'node:fs';
import path from 'node:path';
import { checkBuildPins, deriveBuildTag, stripKeepingLines } from './lib/rr-pins.js';

const SELF_ROUND = /^rr_(zx_\d{8}(?:_\d+)?)/.exec(path.basename(__filename, '.ts'))?.[1] ?? '';
const ROOT = path.join(__dirname, '..');
const MAIN = path.join(ROOT, 'apps/worker-ant-desktop/src/main/index.ts');
const EXEC = path.join(ROOT, 'apps/worker-ant-desktop/src/main/core/agent-executor.ts');
const PLAN = path.join(ROOT, 'plans/improve', `${SELF_ROUND}.md`);
const DIST = path.join(ROOT, 'apps/worker-ant-desktop/dist');

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  PASS ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (actual: unknown, expect: unknown, label: string) =>
  ok(JSON.stringify(actual) === JSON.stringify(expect), label, `${JSON.stringify(actual)} vs ${JSON.stringify(expect)}`);

const mainSrc = fs.readFileSync(MAIN, 'utf-8');
const mainCode = stripKeepingLines(mainSrc).join('\n');
const execSrc = fs.readFileSync(EXEC, 'utf-8');

console.log(`\n【A】构建标识 ${SELF_ROUND}`);
{
  const { tag, count } = deriveBuildTag(execSrc);
  eq(count, 1, 'A1 源码 build 轮次标识恰好 1 处');
  // 方向性比较（不写死本轮值）：源码 build 不得早于本脚本轮次——轮次推进后本脚本仍成立。
  const roundKey = (t: string): [number, number] | null => {
    const m = /^zx_(\d{8})_(\d+)$/.exec(t);
    return m ? [Number(m[1]), Number(m[2])] : null;
  };
  const tagK = roundKey(tag); const selfK = roundKey(SELF_ROUND);
  ok(!!tagK && !!selfK && (tagK[0] > selfK[0] || (tagK[0] === selfK[0] && tagK[1] >= selfK[1])),
    'A2 源码 build 值不早于本脚本轮次（由文件名派生；方向性比较，不写死本轮值）', `${tag} vs ${SELF_ROUND}`);
  checkBuildPins(ok, { distDir: DIST });
  ok(fs.existsSync(PLAN), `A3 方案在册：plans/improve/${SELF_ROUND}.md`);
}

console.log('\n【B】数据目录覆盖仅 dev');
{
  const envUses = [...mainCode.matchAll(/process\.env\.WA_DATA_DIR/g)].length;
  eq(envUses, 1, 'B1 全入口只有一处读 WA_DATA_DIR');
  ok(
    /const devDataDirOverride = isDev \? \(process\.env\.WA_DATA_DIR \|\| ''\)\.trim\(\) : '';/.test(mainCode),
    'B2 WA_DATA_DIR 被 isDev 三元硬闸包住',
  );
  ok(
    /const dataDir = isDev\s*\?\s*\(devDataDirOverride\s*\?\s*path\.resolve\(devDataDirOverride\)/.test(mainCode),
    'B3 dataDir 的覆盖只在 isDev 分支生效',
  );
  ok(
    /:\s*app\.getPath\('userData'\);/.test(mainCode),
    'B4 生产分支仍取 userData（无旁路）',
  );
}

console.log('\n【C】多实例覆盖仅 dev');
{
  const envUses = [...mainCode.matchAll(/process\.env\.WA_ALLOW_MULTI_INSTANCE/g)].length;
  eq(envUses, 1, 'C1 全入口只有一处读 WA_ALLOW_MULTI_INSTANCE');
  ok(
    /const devMultiInstance = isDev && process\.env\.WA_ALLOW_MULTI_INSTANCE === '1';/.test(mainCode),
    'C2 多实例开关被 isDev 与严格等于 "1" 双闸包住',
  );
  ok(
    /const gotLock = devMultiInstance \? true : app\.requestSingleInstanceLock\(\);/.test(mainCode),
    'C3 生产分支恒走 requestSingleInstanceLock',
  );
}

console.log(`\n[rr_zx_20261108_1_contract] ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
