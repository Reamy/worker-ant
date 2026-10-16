/**
 * zx_20261016_5「界」受控复跑 —— 开源边界收窄：**排细节 · 留故事**。
 *
 * 病根：`plans/` 原按"体量"分而按"性质"未分——`plans/project/` 出局，`plans/improve/` 留。
 *   实测这条线**在目录内部就断了**：
 *     ① 定价（Team 档售价）写在 `plans/improve/zx_20261008.md` 里，而 `business-plan/` 正是因"定价是内务"才出局；
 *     ② 那枚一次性 iLink 文件钥匙清理时**只清了 `scripts/`、漏了 `plans/improve/zx_20260924.md`**
 *        ⇒ 它**曾随公开仓快照一同上线**（见 `oss-secret-scan.sh` §7 自述）。
 *   治法：`plans/` **整目录**出局（`plans/project/` 被它涵盖，不另列）；内容资产改由公开摘要
 *   `docs/engineering-log.md` 承接——**留故事，不留细节**。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * §判据（E-1..E-8）
 *   · **机器面**（E-1..E-3）：排除面含 `plans/`；该 const **仍是单行**（sed 解析依赖它）；
 *     按 `oss-secret-scan.sh` 的同一条 sed 复核 ⇒ 解析出的排除项**不塌缩**。
 *   · **P3 两向**（E-4..E-5）：本地树 ⇒ **严格支**（点名 `plans/improve/<tag>.md`）；
 *     无 `plans/improve` ⇒ **豁免支**（记一行说明、**不**计成通过）。一红一绿才证明豁免只对快照生效。
 *   · **文档面**（E-6..E-8）：公开摘要在场且**自带内务清扫**；旧形态 `plans/project/` 独立条目已消失；
 *     边界清单与 `EXCLUDE_PREFIXES` **名实一致**（文档说"不发布"，机器就真不发布）。
 *
 * ── 纪律（承 auto-memory 各条）──────────────────────────────────────────────
 *   G-1 **用生产函数**：`checkBuildPins`/`deriveBuildTag` 一律调生产导出，不在本文件复刻一份等价物。
 *   G-2 **两侧标本**：E-4/E-5 必成对——只有"豁免生效"一侧 ⇒ 任何"全都豁免"的变体都会全票通过。
 *   G-5 静态判据读**原文**（去注释在本仓是静默毁伤）——故 `RD(...)`，不 `strip`。
 *   G-6 **无轮次字面量**：方案路径与脚本名由 `path.basename(__filename)` 派生（末尾自检）。
 *   ⚠ 判据文案**不得含失败字形**（`pnpm rr:all` 的汇总器按日志里的失败字形计数——见 `rr_zx_20261016_4` 踩过的坑）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkBuildPins, deriveBuildTag, stripKeepingLines } from './lib/rr-pins.js';

let pass = 0; let fail = 0;

function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
/** 等值断言（把实际值一并打出——红的时候要能立刻看出"差在哪"）。 */
function eq(actual: unknown, expect: unknown, label: string): void {
  const a = JSON.stringify(actual); const e = JSON.stringify(expect);
  ok(a === e, label, `${a} vs ${e}`);
}

const root = path.join(__dirname, '..');
/** 静态判据读**原文**（G-5：去注释在本仓是静默毁伤）。 */
const RD = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf-8');
/** 本套件轮次标识由**载体自身**派生（G-6）。 */
const SELF_ROUND = path.basename(__filename).replace(/^rr_/, '').replace(/\.ts$/, '');
/** 与 `oss-secret-scan.sh:71` **同一条** sed 的等价物——排除面只有一处真源（`publish-oss.ts`）。 */
const EXCL_LINE_RE = /^const EXCLUDE_PREFIXES = \[(.*)\];$/m;

/** 采集 `checkBuildPins` 播报的断言与说明（用于 P3 两向自检；不落盘、不改生产）。 */
function capturePins(plansDir: string): { labels: string[]; logs: string[] } {
  const labels: string[] = [];
  const logs: string[] = [];
  const realLog = console.log;
  console.log = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); };
  try {
    checkBuildPins((_cond, label) => labels.push(label), { plansDir });
  } finally {
    console.log = realLog;
  }
  return { labels, logs };
}

async function main(): Promise<void> {
  console.log('\n【E】开源边界收窄（排细节 · 留故事）');

  const PUB = RD('scripts/publish-oss.ts');
  const SCAN = RD('scripts/oss-secret-scan.sh');
  const SCOPE = RD('business-plan/materials/open-source-scope.md');
  const LOG = path.join(root, 'docs/engineering-log.md');

  // ═══ 机器面：排除面一处真源（G-5 读原文）═══════════════════════════════════
  ok(/'plans\/'/.test(PUB), 'E-1 ★`EXCLUDE_PREFIXES` 含**整目录** `plans/`（原只排 `plans/project/`）');

  const exclLines = PUB.split('\n').filter((l) => l.startsWith('const EXCLUDE_PREFIXES'));
  eq([exclLines.length, EXCL_LINE_RE.test(exclLines[0] ?? '')], [1, true],
    'E-2 ★`EXCLUDE_PREFIXES` 仍是**单行**且形如 `const EXCLUDE_PREFIXES = [...];`——' +
    '`oss-secret-scan.sh` 的 sed 按此形解析，换行即令发布面扫描**静默塌缩**');

  const parsed = (EXCL_LINE_RE.exec(PUB)?.[1] ?? '').replace(/["'\s]/g, '').split(',').filter(Boolean);
  ok(parsed.length >= 2 && parsed.includes('plans/') && !parsed.includes('plans/project/'),
    'E-3 ★★按 `oss-secret-scan.sh` 的同一条 sed 复核：排除面**解析得出**（不塌缩）、含 `plans/`、' +
    '且 `plans/project/` 已**并入**（不留独立条目——两处真源即两处会漂）',
    `${parsed.length} 条：${parsed.join(',')}`);

  // ═══ P3 两向自检（G-2：一红一绿才证明豁免只对"发布面快照"生效）═════════════
  const tag = deriveBuildTag(RD('apps/worker-ant-desktop/src/main/core/agent-executor.ts')).tag;
  const local = capturePins(path.join(root, 'plans/improve'));
  ok(local.labels.some((l) => l === `方案在册：plans/improve/${tag}.md`),
    'E-4 ★★本地开发树（`plans/improve` 在）⇒ 走的是**严格支**：仍点名 `plans/improve/<真源 tag>.md`',
    tag);

  const sealed = capturePins(path.join(os.tmpdir(), 'rr-e5-no-such-plans-dir'));
  ok(!sealed.labels.some((l) => l.startsWith('方案在册：')) && sealed.logs.some((l) => l.includes('P3 豁免')),
    'E-5 ★★发布面快照（无 `plans/improve`）⇒ 走**豁免支**：只记一行说明、**不**计成通过' +
    '（豁免若被写成一条恒真断言，E-4 那一侧就失去意义）');

  // ═══ 文档面：名实一致（文档说"不发布"，机器就真不发布）══════════════════════
  const logText = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf-8') : '';
  ok(logText.length > 400
    && !/[¥]|元\/月|business-plan/.test(logText),
    'E-6 公开摘要 `docs/engineering-log.md` 在场、非空，且**自带内务清扫**（无定价字形、无内务目录字样）',
    `${logText.length} 字符`);

  ok(!(exclLines[0] ?? '').includes('plans/project/') && !parsed.includes('plans/project/'),
    'E-7 反证：旧形态（`plans/project/` 作为**独立条目**）已消失——防"追加了 `plans/` 却留着旧条目"的双真源');

  ok(/\|\s*~~`plans\/improve\/`[^|]*\|\s*❌/.test(SCOPE) && /整目录/.test(SCOPE),
    'E-8 ★边界清单 §3 已把 `plans/improve/` 记为**不发布**，§5 记明"整目录出局"——' +
    '与 `EXCLUDE_PREFIXES` 同一把尺（文档与机器各说各话即名实不符）');

  // ═══ S 哑雷自检 + build 钉（派生核对，不写轮次字面量）═══════════════════════
  console.log('\n【S】哑雷自检 + build 钉（派生核对，不写轮次字面量）');
  {
    const selfLines = stripKeepingLines(RD(`scripts/${path.basename(__filename)}`)).join('\n');
    const selfPins = [...selfLines.matchAll(/(?<![A-Za-z0-9_])(?:build:\s*|ROUND\s*=\s*|includes\()'(zx_[0-9_]+)'/g)];
    ok(selfPins.length === 0, 'S1 本文件零 build 轮次字面量（G-6：不写"只为下一轮"的哑雷）',
      selfPins.map((m) => m[1]).join(',') || '0 处');
    ok(/zx_\d{8}/.test(SELF_ROUND) && fs.existsSync(path.join(root, `plans/improve/${SELF_ROUND}.md`)),
      'S2 ★方向性自指（由载体自身派生，非抄来的常量）：本轮方案文件在场', `plans/improve/${SELF_ROUND}.md`);
    ok(fs.existsSync(path.join(root, `scripts/rr_${SELF_ROUND}.ts`)),
      'S3 本套件在册（脚本名由载体派生）', `scripts/rr_${SELF_ROUND}.ts`);

    checkBuildPins(ok, { distDir: path.join(root, 'apps/worker-ant-desktop/dist') });
  }
}

// ⚠ `catch` 不可省：夹具/断言**抛异常**时若只挂 `finally`，`process.exit` 会在 Node 报告 unhandled
//   rejection **之前**把进程带走 ⇒ 跑到一半崩掉的复跑会打出一行假绿。
main().catch((e: unknown) => {
  console.error('\n💥 rr_zx_20261016_5 未捕获异常（复跑**未跑完**，不得读作通过）：', e);
  fail++;
}).finally(() => {
  console.log(`\n${fail === 0 ? '✅' : '❌'} rr_zx_20261016_5: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
});
