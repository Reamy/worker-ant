/**
 * zx_20261016_4 受控复跑 —— 「闭」（道德经·**善闭无关楗而不可开**）。
 *
 * 本轮只做一件事：把 `zx_20261005 M7` 留下的**唯一廉价绕过**堵上——
 *   试用起算点原先只写 `wa_settings` 里**一行**，而 `ensureSetting` 只在缺时插 ⇒
 *   **删那一行**，下次启动就把"此刻"重算进去 ⇒ 试用**永远重置**，且经 `team-gate.ts:54`
 *   （`kind==='trial'` 解锁全部四件 Team 能力）顺带白拿。绕过成本＝**一行 SQL、零代码改动**。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * §判据（N-1..N-17）
 *   治法＝**两处锚点 · 取早者 · 缺一侧自愈**：库内行 + 库外封印 `data/license-anchor.json`。
 *   · **接线**（N-1..N-4）：三跳齐全（读两处 → `resolveTrialAnchor` 裁决 → 回写两处）；
 *     反证旧形态已消失；回写须是 `INSERT OR REPLACE`；封印模块**零相对 import**。
 *   · **裁决行为**（N-5..N-11）：两侧标本——两处皆无⇒首启／只库内⇒`db`／**只封印⇒`seal`**／
 *     两处取**早**／**库内塞未来⇒取封印**／两处皆非法⇒首启／`isUsableAnchor` 四态。
 *   · **封印 IO**（N-12..N-15）：缺件⇒null／写读往返／坏 JSON⇒null／字段类型不对⇒null（**都不 throw**）。
 *   · **验收点**（N-16..N-17）：删库行后重启 ⇒ 仍第 7 天（**不是**满 14 天）；配一条"旧形态后果"的对照标本，
 *     一红一绿才证明堵的正是这件事。
 *
 * ── 纪律（承 auto-memory 各条）──────────────────────────────────────────────
 *   G-1 **用生产函数**：`resolveTrialAnchor`/`isUsableAnchor`/`readSeal`/`writeSeal` 一律调生产导出，
 *       不在本文件复刻一份"等价物"（复刻件即"判据的自我印证"）。
 *   G-2 **两侧标本**：每个判据都要能红——本轮实测的突变检验见方案 §2（改封印支⇒N-7/N-9/N-16 三红）。
 *   G-4 **不依赖真实墙钟**：`now` 一律注入。
 *   G-5 静态判据读**原文**（去注释在本仓是静默毁伤）——故 `RD(...)`，不 `strip`。
 *   G-6 **无轮次字面量**：方案路径与脚本名由 `path.basename(__filename)` 派生（末尾自检）。
 *
 * ⚠ 为何裁决要同 IO 剥开：`initDatabase` 装不进 rr 进程（better-sqlite3 的 Electron ABI 与测试进程冲突）
 *   ⇒ 有副作用的启动路径**测不到**；故把**纯裁决**抽成 `core/license-anchor.ts` 直测，
 *   接线那一跳以静态形状钉在 `database.ts` 上。**真跑 `initDatabase`** 的那一跳仍靠实机 E2E（方案 §5 已登记为未做）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';
// G-1：判据引用的生产符号**全部静态导入** ⇒ 被删/改名即**编译期失败**（而非"扫了个空、静默假绿"）。
import {
  LICENSE_SETTING_KEYS, TRIAL_DAYS, resolveLicenseState, type LicenseSettingDb,
} from '../apps/worker-ant-desktop/src/main/core/license.js';
import {
  TRIAL_ANCHOR_FILENAME, isUsableAnchor, resolveTrialAnchor, readSeal, writeSeal,
} from '../apps/worker-ant-desktop/src/main/core/license-anchor.js';

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
const A = 'apps/worker-ant-desktop';
/** 静态判据读**原文**（G-5：去注释在本仓是静默毁伤——"注释里写着有、代码里没有"正是要防的形态）。 */
const RD = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf-8');
/** 本套件轮次标识由**载体自身**派生（G-6：不写"只为下一轮为真"的字面量）。
 *  ⚠ 本文件名无 `_<词>` 后缀（`rr_<tag>.ts`），故只剥 `.ts`——照抄带后缀那套会把 tag 剥成 `zx_…_4.ts`。 */
const SELF_ROUND = path.basename(__filename).replace(/^rr_/, '').replace(/\.ts$/, '');

const NOW = new Date('2026-10-16T00:00:00.000Z');
const FP = 'AAAA-BBBB-CCCC-DDDD';
const DAY = 86_400_000;

/** 接 `resolveLicenseState` 的最小库面（夹具 DDL 与生产 `database.ts` 的 wa_settings 同形）。 */
function licDb(settings: Record<string, string> = {}): LicenseSettingDb {
  const d = new DatabaseSync(':memory:');
  d.exec("CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')))");
  for (const [k, v] of Object.entries(settings)) d.prepare('INSERT INTO wa_settings (key,value) VALUES (?,?)').run(k, v);
  return d as unknown as LicenseSettingDb;
}

async function main(): Promise<void> {
  console.log('\n【N】试用起算点不可重置（两处锚点 · 取早者 · 缺一侧自愈）');

  const DB = RD(`${A}/src/main/database.ts`);
  const ANC = RD(`${A}/src/main/core/license-anchor.ts`);

  // ═══ 接线（静态形状，G-5 读原文）═══════════════════════════════════════════
  ok(/resolveTrialAnchor\(/.test(DB) && /readSeal\(trialSealPath\)/.test(DB) && /writeSeal\(trialSealPath/.test(DB),
    'N-1 ★★接线三跳齐全：`database.ts` 取两处（库内行 + `readSeal`）→ `resolveTrialAnchor` 裁决 → `writeSeal` 回写（缺任一跳即哑）');
  ok(!/ensureSetting\(LICENSE_SETTING_KEYS\.trialStartedAt/.test(DB),
    'N-2 ★反证：旧的 `ensureSetting(...)` 单处写入形态**已消失**（"只在缺时插"正是可重置的根因）');
  ok(/INSERT OR REPLACE INTO wa_settings[\s\S]{0,120}?\.run\(LICENSE_SETTING_KEYS\.trialStartedAt/.test(DB),
    'N-3 回写走 `INSERT OR REPLACE`（非 IGNORE）——自愈那一跳靠它把被删/被改的库内行写回');
  ok(/TRIAL_ANCHOR_FILENAME/.test(ANC) && /license-anchor\.json/.test(ANC) && !/from '\.\.?\//.test(ANC),
    'N-4 封印模块**零项目依赖**（无任何相对 import ⇒ 裁决可脱库直跑；否则 rr 里 import 它就是 import 整条引擎链）');

  // ═══ 裁决行为：两侧标本（G-2；入参即全部事实 ⇒ 不碰盘/表/墙钟，G-4）═════════
  const t7 = new Date(NOW.getTime() - 7 * DAY).toISOString(); // 更早的那个真值
  const t3 = new Date(NOW.getTime() - 3 * DAY).toISOString(); // 更晚的那个
  eq(resolveTrialAnchor({ dbValue: undefined, sealValue: undefined, now: NOW }),
    { startIso: NOW.toISOString(), firstRun: true, healedFrom: null },
    'N-5 两处皆无 ⇒ **首启**（起算点＝此刻）——这一支必须留着，否则新装机根本跑不起来');
  eq(resolveTrialAnchor({ dbValue: t7, sealValue: undefined, now: NOW }).healedFrom, 'db',
    'N-6 只有库内有（封印被删）⇒ 取库内值、标 `healedFrom: db`（下次回写即把封印补回）');
  eq(resolveTrialAnchor({ dbValue: undefined, sealValue: t7, now: NOW }).healedFrom, 'seal',
    'N-7 ★★**只有封印有**（库内行被删——**正是要被堵的那条路**）⇒ 取封印值、标 `healedFrom: seal`，**绝不回落首启**');
  eq(resolveTrialAnchor({ dbValue: t7, sealValue: t3, now: NOW }).startIso, t7,
    'N-8 ★★两处皆在且不同 ⇒ **取早者**（删一侧只能让起算点不变、绝不变晚——单调性即这套设计的关节）');
  eq(resolveTrialAnchor({ dbValue: new Date(NOW.getTime() + 365 * DAY).toISOString(), sealValue: t7, now: NOW }).startIso, t7,
    'N-9 ★★库内被塞**未来时刻**（假造延期）⇒ 该侧判不可用 ⇒ 取封印那个真值（不是取它，也不是回落首启）');
  eq(resolveTrialAnchor({ dbValue: '不是时刻', sealValue: '2026-13-99T99:99:99Z', now: NOW }),
    { startIso: NOW.toISOString(), firstRun: true, healedFrom: null },
    'N-10 两处皆非法 ⇒ 首启（坏值不得被当成"合法起算点"——否则坏数据＝无限试用）');
  ok(isUsableAnchor(t7, NOW) && !isUsableAnchor(new Date(NOW.getTime() + 1).toISOString(), NOW)
    && !isUsableAnchor(null, NOW) && !isUsableAnchor('', NOW),
    // ⚠ 判据文案**不得含 ✓/✗ 字形**：`pnpm rr:all` 的汇总器按日志里的失败字形计数
    //   （实测：本条原写「未来时刻 ✗ ／ null ✗ ／ 空串 ✗」⇒ 三个字形被判成"3 条失败"，
    //   而账上是 28/0 —— 判据文案自己把自己弄红）。故改用文字表述。
    'N-11 `isUsableAnchor` 两侧标本：过去的合法时刻**收**；未来时刻／null／空串**皆拒**');

  // ═══ 封印文件 IO：写→读往返 + 坏件不炸（"不 throw"是软闸纪律的延续）═══════════
  const sealDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-lic-seal-'));
  try {
    const sealPath = path.join(sealDir, TRIAL_ANCHOR_FILENAME);
    eq(readSeal(sealPath), null, 'N-12 封印文件不在 ⇒ `readSeal` 回 null（不 throw）');
    ok(writeSeal(sealPath, t7) === true && readSeal(sealPath) === t7,
      'N-13 ★写→读往返：落盘后取回**同一** ISO（两处锚点靠它对齐；写入走 0600）');
    fs.writeFileSync(sealPath, '{ 这不是 JSON');
    eq(readSeal(sealPath), null, 'N-14 ★坏封印（非 JSON）⇒ 回 null 而非抛异常（宁可少一处锚，不可打不开）');
    fs.writeFileSync(sealPath, JSON.stringify({ trialStartedAt: 42 }));
    eq(readSeal(sealPath), null, 'N-15 字段类型不对（数字）⇒ 回 null（只认字符串，不猜）');
  } finally {
    fs.rmSync(sealDir, { recursive: true, force: true });
  }

  // ═══ 端到端（两模块合一）：**库行被删**、封印仍在 ⇒ 重启后仍认那个起算点 ═══════
  // rr 里跑不了 `initDatabase`（ABI），故按它的**真实次序**手工演一遍：
  // 裁决（缺库内行）→ 把结果写进新库 → `resolveLicenseState` 读它。
  const healed = resolveTrialAnchor({ dbValue: null, sealValue: t7, now: NOW });
  const stHealed = resolveLicenseState(licDb({ [LICENSE_SETTING_KEYS.trialStartedAt]: healed.startIso }), { now: NOW, fingerprint: FP });
  eq([stHealed.kind, stHealed.trialDaysLeft], ['trial', TRIAL_DAYS - 7],
    'N-16 ★★删库行后重启：起算点由**封印**顶回 ⇒ 仍是第 7 天（**不是**重置成满 14 天）——本条即本轮验收点');
  eq(resolveLicenseState(licDb({ [LICENSE_SETTING_KEYS.trialStartedAt]: NOW.toISOString() }), { now: NOW, fingerprint: FP }).trialDaysLeft,
    TRIAL_DAYS,
    'N-17 对照标本（**旧形态**的后果）：起算点被重算成此刻 ⇒ 满 TRIAL_DAYS——N-16 与它一红一绿，才证明堵的正是这件事');

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

    checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });
  }
}

// ⚠ `catch` 不可省：夹具/断言**抛异常**时若只挂 `finally`，`process.exit` 会在 Node 报告 unhandled
//   rejection **之前**把进程带走 ⇒ 跑到一半崩掉的复跑会打出一行 ✅ 假绿。
main().catch((e: unknown) => {
  console.error('\n💥 rr_zx_20261016_4 未捕获异常（复跑**未跑完**，不得读作通过）：', e);
  fail++;
}).finally(() => {
  console.log(`\n${fail === 0 ? '✅' : '❌'} rr_zx_20261016_4: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
});
