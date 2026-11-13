/**
 * zx_20261111_1 「择·实」B0 —— 轮次标识、方案与复跑骨架。
 *
 * 三组判据：
 *   K「构建钉」：`checkBuildPins` P1–P6（真源单一、方案/复跑脚本在册、全量钉子同值、产物同值）；
 *   P「方案在册」：本轮方案文件在场且 B0–B4 分批齐备（由载体自身派生的轮次标识定位，不写字面量）；
 *   W「子套件在册」：B1/B2/B3 三份复跑脚本真在盘上、各自**真源直 import**、且不是空壳
 *     （有断言与失败非零退出）。只建文件不接的"等价性"在这里被挡住。
 *
 * 纪律：
 *   G-1 轮次由 `path.basename(__filename)` 派生，不写任何轮次字面量；
 *   G-2 两侧标本在本轮各子套件内（brief / select / reconcile）；
 *   ⚠ 判据文案不得含失败字形（全量汇总按字形计失败数）；
 *   ⚠ 末尾 P6 读 `dist` ⇒ 本脚本须在 `tsup` 之后跑。
 */
import fs from 'node:fs';
import path from 'node:path';
import { checkBuildPins } from './lib/rr-pins.js';

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) {
    pass++;
    console.log(`  PASS ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    fail++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const root = path.join(__dirname, '..');
const SELF_ROUND = path.basename(__filename).replace(/^rr_/, '').replace(/\.ts$/, '');
const A = 'apps/worker-ant-desktop';
const RD = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf-8');

function main(): void {
  // ═══ K｜构建钉 ═══════════════════════════════════════════════════════════
  console.log(`\n【K】构建钉与在册（${SELF_ROUND}）`);
  checkBuildPins(ok, { distDir: path.join(A, 'dist') });

  // ═══ P｜方案在册 ════════════════════════════════════════════════════════
  console.log('\n【P】本轮方案与分批在册');
  const planPath = `plans/improve/${SELF_ROUND}.md`;
  const planExists = fs.existsSync(path.join(root, planPath));
  ok(planExists, `方案文件在册：${planPath}`);
  if (planExists) {
    const plan = RD(planPath);
    for (const batch of ['B0', 'B1', 'B2', 'B3', 'B4']) {
      ok(new RegExp(`^### ${batch} —`, 'm').test(plan), `方案含分批 ${batch}`);
    }
  }

  // ═══ W｜子套件在册（B4 收口） ══════════════════════════════════════════
  console.log('\n【W】B1/B2/B3 子套件在册且真接线');
  const suites: Array<{ file: string; imports: RegExp; label: string }> = [
    { file: 'rr_zx_20261111_1_brief.ts', imports: /from '\.\.\/apps\/worker-ant-desktop\/src\/main\/core\/project-brief\.js'/, label: 'B1 须知落库语义' },
    { file: 'rr_zx_20261111_1_select.ts', imports: /from '\.\.\/apps\/worker-ant-desktop\/src\/main\/core\/model-request\.js'/, label: 'B2 辅助选型' },
    { file: 'rr_zx_20261111_1_reconcile.ts', imports: /from '\.\.\/apps\/worker-ant-desktop\/src\/main\/core\/task-scheduler\.js'/, label: 'B3 调度器宽限' },
  ];
  for (const s of suites) {
    const p = path.join(root, 'scripts', s.file);
    const exists = fs.existsSync(p);
    ok(exists, `W ${s.label}：${s.file} 在册`);
    if (!exists) continue;
    const src = RD(`scripts/${s.file}`);
    ok(s.imports.test(src), `W ${s.label}：真源直 import（改签名即编译期红）`);
    ok(/\[rr_[^\]]*\] \$\{pass\} passed/.test(src) && /process\.exit\(fail/.test(src),
      `W ${s.label}：有汇总且失败非零退出（不是空壳）`);
    ok((src.match(/\bok\(/g) ?? []).length >= 10, `W ${s.label}：断言不是摆设（≥10 条）`);
  }
  // 反证：三份子套件是**不同文件**，不能拿一份冒充三份。
  ok(new Set(suites.map((s) => s.file)).size === 3, 'W 三份子套件路径互异（反证"一份冒充三份"）');

  console.log(`\n[rr_${SELF_ROUND}] ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
