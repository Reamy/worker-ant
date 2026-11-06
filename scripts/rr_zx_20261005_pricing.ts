/**
 * zx_20261005 受控复跑 —— 批三 M11「定价真源对齐」（管子·度量衡：一把尺）。
 *
 * 病根：能力上限（`feature-limits.ts`，M5）与价格**各记各的**——两处都用 community/pro/team 三个词，
 *   却无物强制对齐。加一档忘加价、改价忘改能力描述，只在用户看到时才暴露。
 *
 * 本套件钉四件事：
 *  ① **键集一一对应**：`PRICING` 的键恰等于 `LICENSE_TIERS`（运行时验；类型层已由 `Record<LicenseTier,…>` 兜住）。
 *  ② **label 同源**：每档 `label` 皆取 `TIER_LABEL`，不另立一份档位名。
 *  ③ **能力行派生**：`capabilityLine` 由 `TIER_LIMITS` 派生（**改上限即变**）——价格表里的话＝执行时生效的上限。
 *     两侧标本：runtime 逐档比对 + 静态钉 `capabilityLine` 函数体引 `TIER_LIMITS`（防退化成抄字面量）。
 *  ④ **早鸟是 SKU 不是档位**：`EARLY_BIRD` **不**在 `PRICING` 键集、`isLicenseTier('earlybird')===false`。
 * 外加「真源唯一 + 渲染层零硬编码价 + IPC 接线 + 产物中文串」。
 *
 * ── 纪律（承 auto-memory 各条）──────────────────────────────────────────────
 *   G-1 用生产函数：PRICING/pricingRows/capabilityLine/TIER_LIMITS/TIER_LABEL 一律调生产导出。
 *   G-2 两侧标本：免费档与非免费档并存、能力行按档不同、"真源唯一"扫描面含排除项。
 *   G-4 不依赖真实墙钟/环境（纯常量与纯函数）。
 *   G-5 静态判据读**原文**（去注释在本仓是静默毁伤）——一律 `RD(...)`。
 *   G-6 无轮次字面量：方案路径与脚本名由 `path.basename(__filename)` 派生（末尾自检）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';
import { LICENSE_TIERS, TIER_LABEL, TIER_LIMITS, isLicenseTier } from '../apps/worker-ant-desktop/src/main/core/feature-limits.js';
import { PRICING, EARLY_BIRD, pricingRows, capabilityLine } from '../apps/worker-ant-desktop/src/main/core/pricing.js';

let pass = 0; let fail = 0;

function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
function eq(actual: unknown, expect: unknown, label: string): void {
  const a = JSON.stringify(actual); const e = JSON.stringify(expect);
  ok(a === e, label, `${a} vs ${e}`);
}

const root = path.join(__dirname, '..');
const A = 'apps/worker-ant-desktop';
/** 静态判据读**原文**（G-5）。 */
const RD = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf-8');
/** 递归收集某目录下全部 `.ts`/`.tsx`（"真源唯一 / 零硬编码"的扫描面）。 */
function walkSrc(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkSrc(p));
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}
/** 本套件轮次标识由**载体自身**派生（G-6）。 */
const SELF_ROUND = path.basename(__filename).replace(/^rr_/, '').replace(/_pricing\.ts$/, ''); // zx_20261005

/** 从原文里截出某函数体（配对花括号）——静态钉"函数体引了谁"用。 */
function fnBody(src: string, header: string): string {
  const i = src.indexOf(header);
  if (i < 0) return '';
  const open = src.indexOf('{', i);
  if (open < 0) return '';
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(open, j + 1);
  }
  return '';
}

async function main(): Promise<void> {
  const PRICING_SRC = `${A}/src/main/core/pricing.ts`;

  // ═══ ① 键集一一对应 ════════════════════════════════════════════════════════
  console.log('\n【M11-①】价格表与档位词表**一一对应**');
  {
    eq(Object.keys(PRICING).sort(), [...LICENSE_TIERS].sort(),
      'M11-1a `PRICING` 键集恰等于 `LICENSE_TIERS`（加/删档位漏改价格 ⇒ 此红）');
    const missingLabel = LICENSE_TIERS.filter((t) => PRICING[t].label !== TIER_LABEL[t]);
    eq(missingLabel, [], 'M11-1b 每档 `label` 取 `TIER_LABEL`（**不另立一份**档位名——两处漂移即红）');
    const wrongTier = LICENSE_TIERS.filter((t) => PRICING[t].tier !== t);
    eq(wrongTier, [], 'M11-1c 每档 `tier` 字段与其键一致（防"张冠李戴"的行）');
  }

  // ═══ ② 能力行由 TIER_LIMITS 派生 ═════════════════════════════════════════
  console.log('\n【M11-②】能力行**派生**自 `TIER_LIMITS`（价格表的话＝执行时生效的上限）');
  {
    // 本地独立重派生（不调生产函数）：若生产用抄来的字面量，改 TIER_LIMITS 后两侧会分家。
    const rederive = (t: (typeof LICENSE_TIERS)[number]): string => {
      const l = TIER_LIMITS[t];
      const proj = l.maxProjects === 0 ? '不限项目' : `${l.maxProjects} 个项目`;
      // zx_20261023_1「称」: 能力行的第三段由「席位」改为「协同节点」（席位只数本机账号、跨机不可聚合）。
      const nodes = l.maxNodes === 0 ? '不限节点' : `协同节点 ${l.maxNodes} 台`;
      return `并发 ${l.maxProjectConcurrency} · ${proj} · ${nodes}`;
    };
    const mismatch = LICENSE_TIERS.filter((t) => capabilityLine(t) !== rederive(t));
    eq(mismatch, [], 'M11-2a `capabilityLine(t)` 与"由 `TIER_LIMITS[t]` 重派生"逐档一致（价格表≠真上限即红）');
    const lines = LICENSE_TIERS.map((t) => capabilityLine(t));
    ok(new Set(lines).size === lines.length,
      'M11-2b 各档能力行**互不相同**（区分度——若全一个样，说明没真读限制）', lines.join(' | '));
    const body = fnBody(RD(PRICING_SRC), 'export function capabilityLine');
    ok(/TIER_LIMITS\s*\[/.test(body), 'M11-2c ★静态钉：`capabilityLine` 函数体**引 `TIER_LIMITS`**（防退化成抄死的字面量）');
    ok(!/maxProjectConcurrency\s*:\s*\d/.test(body), 'M11-2d 反证：函数体内**无**内联的并发数字面量（只有派生，没有抄写）');
  }

  // ═══ ③ 价格值（两侧标本：免费档 ∧ 付费档并存）═══════════════════════════
  console.log('\n【M11-③】价格值（免费档与付费档**并存**——不是"全一样"或"全免费"）');
  {
    eq(PRICING.community.priceMonthlyCny, 0, 'M11-3a 社区档月付为 0（开源免费——BUSINESS-PLAN 口径）');
    eq([PRICING.pro.priceMonthlyCny, PRICING.pro.priceYearlyCny], [99, 899], 'M11-3b 专业档 ¥99/月 · ¥899/年');
    eq([PRICING.team.priceMonthlyCny, PRICING.team.priceYearlyCny], [599, 5990],
      'M11-3c ★团队授权包 ¥599/月 · ¥5990/年（按包计价，年付≈10 个月）');
    eq(PRICING.team.priceNote, '团队授权包',
      'M11-3d 团队档上屏口径写明「团队授权包」（不再出现 /人/月）');
    ok(PRICING.team.priceYearlyCny > 0 && PRICING.team.priceYearlyCny > PRICING.team.priceMonthlyCny,
      'M11-3h 团队包同时提供月付与年付，且年价 > 月价');
    ok(capabilityLine('team').includes(`协同节点 ${TIER_LIMITS.team.maxNodes} 台`) && !capabilityLine('team').includes('席'),
      'M11-3i 团队能力行按**协同节点**派生（与 `TIER_LIMITS` 同源，不写"席位"）', capabilityLine('team'));
    const free = LICENSE_TIERS.filter((t) => PRICING[t].priceMonthlyCny === 0);
    const paid = LICENSE_TIERS.filter((t) => PRICING[t].priceMonthlyCny > 0);
    ok(free.length >= 1 && paid.length >= 1, 'M11-3e ★两侧标本：**有**免费档**且**有付费档（唯免费/唯付费都不会全票通过）',
      `免费 ${free.length} / 付费 ${paid.length}`);
    const badYear = LICENSE_TIERS.filter((t) => PRICING[t].priceYearlyCny > 0 && PRICING[t].priceYearlyCny <= PRICING[t].priceMonthlyCny);
    eq(badYear, [], 'M11-3f 提供年付的档，年价 > 月价（年付更省的口径自洽——不是"年付反而贵"）');
    const emptyBenefits = LICENSE_TIERS.filter((t) => !Array.isArray(PRICING[t].benefits) || PRICING[t].benefits.length === 0);
    eq(emptyBenefits, [], 'M11-3g 每档都有 ≥1 条卖点（否则"档"只是个价格数字，没有可交换的说明）');
  }

  // ═══ ④ 早鸟终身是 SKU、不是档位 ═══════════════════════════════════════════
  console.log('\n【M11-④】早鸟终身＝**购买 SKU**（能力上限仍是 pro），**不**混入档位词表');
  {
    eq(EARLY_BIRD.appliesTier, 'pro', "M11-4a 早鸟 `appliesTier === 'pro'`（一次买断 Pro 终身——能力上限归 pro）");
    ok(!(LICENSE_TIERS as readonly string[]).includes('earlybird'),
      'M11-4b ★早鸟**未**被塞进 `LICENSE_TIERS`（塞进去会让 TIER_LIMITS/TIER_LABEL 各缺一格 = 编译期坑）');
    ok(!Object.prototype.hasOwnProperty.call(PRICING, 'earlybird'),
      'M11-4c 早鸟**不在** `PRICING` 键集（SKU ≠ 档位，两者容器分开）');
    ok(isLicenseTier(EARLY_BIRD.appliesTier), 'M11-4d 早鸟指向的档位**必是合法档位**（`isLicenseTier` 验）');
    ok(EARLY_BIRD.priceCny > 0 && EARLY_BIRD.seats > 0, 'M11-4e 早鸟有正价与正名额上限',
      `¥${EARLY_BIRD.priceCny} × ${EARLY_BIRD.seats}`);
  }

  // ═══ ⑤ 上屏行形状 ═════════════════════════════════════════════════════════
  console.log('\n【M11-⑤】`pricingRows()` 上屏行＝定价 ⊕ 派生能力行');
  {
    const rows = pricingRows();
    eq(rows.map((r) => r.tier), [...LICENSE_TIERS], 'M11-5a 行的顺序取 `LICENSE_TIERS`，逐档不多不少');
    eq(rows.map((r) => r.capability), LICENSE_TIERS.map((t) => capabilityLine(t)),
      'M11-5b 每行的 `capability` 即 `capabilityLine(tier)`（同一把尺，不另算）');
  }

  // ═══ ⑥ 真源唯一：价与能力上限的字段只此一处 ══════════════════════════════
  console.log('\n【M11-⑥】真源唯一（管子·度量衡：不许散落硬编码）');
  {
    const scanDirs = [path.join(root, A, 'src'), path.join(root, 'packages')];
    const files: string[] = [];
    for (const d of scanDirs) if (fs.existsSync(d)) files.push(...walkSrc(d));
    // zx_20261018_2 批五：`core/tier-catalog.ts` 会**透传**这两个字段（读模型），故分两判：
    //   ① 引用面逐项枚举（真源 + 唯一读模型，不出现第三处）；
    //   ② **硬编码价格字面量**仍只许在真源（透传 `p.priceMonthlyCny` 不算第二份价）。
    const CATALOG_SRC = `${A}/src/main/core/tier-catalog.ts`;
    const priceOwners = files
      .filter((f) => /priceMonthlyCny|priceYearlyCny/.test(RD(path.relative(root, f))))
      .map((f) => path.relative(root, f));
    eq(priceOwners, [PRICING_SRC, CATALOG_SRC],
      'M11-6a ★价格字段引用面逐项枚举（真源 + 唯一透传读模型，无第三处）');
    const priceLiterals = files
      .filter((f) => /price(?:Monthly|Yearly)Cny\s*:\s*\d/.test(RD(path.relative(root, f))))
      .map((f) => path.relative(root, f));
    eq(priceLiterals, [PRICING_SRC], 'M11-6a2 ★硬编码价格字面量仅在 `core/pricing.ts`（派生行只许透传）');
    const capOwners = files
      .filter((f) => /TIER_LIMITS\s*[:=]/.test(RD(path.relative(root, f))))
      .map((f) => path.relative(root, f));
    eq(capOwners, [`${A}/src/main/core/feature-limits.ts`],
      'M11-6b ★能力上限表 `TIER_LIMITS` **仅**定义于 `feature-limits.ts`（既有真源未被复制）');
  }

  // ═══ ⑦ 接线：IPC + 渲染层第二落点（不硬编码价）═══════════════════════════
  console.log('\n【M11-⑦】接线：main IPC → renderer（渲染层**零**硬编码价）');
  {
    const LIC_IPC = RD(`${A}/src/main/ipc/license.ipc.ts`);
    ok(LIC_IPC.includes("'license:pricing'") && /pricingRows\(/.test(LIC_IPC),
      'M11-7a main 提供 `license:pricing` 通道且调生产 `pricingRows()`（壳薄，不在此重算价）');
    const RIPC = RD(`${A}/renderer/src/lib/ipc.ts`);
    ok(RIPC.includes("'license:pricing'") && /PricingPayload/.test(RIPC),
      'M11-7b 渲染层 API 在册且形状引 main 真源 `PricingPayload`');
    const SET = RD(`${A}/renderer/src/pages/SettingsPage.tsx`);
    ok(/licenseApi\.pricing\(\)/.test(SET), 'M11-7c `SettingsPage` **经 IPC** 取定价（真源在 main，渲染层不自判）');
    const rFiles = walkSrc(path.join(root, A, 'renderer/src'));
    const hard = rFiles
      .filter((f) => /¥\s?(99|199|1999)\b/.test(RD(path.relative(root, f))))
      .map((f) => path.relative(root, f));
    eq(hard, [], 'M11-7d ★renderer **零**硬编码价格串（`¥99`/`¥199`/`¥1999`——改价只改真源一处）');
    ok(!/const\s+PURCHASE_URL/.test(SET),
      'M11-7e 购买入口 URL 也收归真源（`SettingsPage` 不再本地悬一个 `PURCHASE_URL`）');
  }

  // ═══ ⑧ 产物：定价块中文串真打进 GUI ═══════════════════════════════════════
  console.log('\n【M11-⑧】词表第二落点：定价块中文可见串真进 renderer 产物（搜符号会假绿）');
  {
    const assetsDir = path.join(root, A, 'renderer/dist/assets');
    const chunks = fs.existsSync(assetsDir) ? fs.readdirSync(assetsDir).filter((f) => /^SettingsPage-.*\.js$/.test(f)) : [];
    const js = chunks.length === 1 ? fs.readFileSync(path.join(assetsDir, chunks[0]!), 'utf-8') : '';
    ok(js !== '', 'M11-8a renderer 产物恰 1 份 `SettingsPage-*.js`（本判据须 renderer 先 build）');
    ok(js.includes('定价与权益') && js.includes('能力上限'),
      'M11-8b **上屏到产物**：定价块中文串在产物内——"只写在源码、没打进 GUI"在此必红',
      `定价与权益=${js.includes('定价与权益')} · 能力上限=${js.includes('能力上限')}`);
  }

  // ═══ S 哑雷自检 + build 钉 ═════════════════════════════════════════════════
  console.log('\n【S】哑雷自检 + build 钉（派生核对，不写轮次字面量）');
  {
    const selfLines = stripKeepingLines(RD(`scripts/${path.basename(__filename)}`)).join('\n');
    const selfPins = [...selfLines.matchAll(/(?<![A-Za-z0-9_])(?:build:\s*|ROUND\s*=\s*|includes\()'(zx_[0-9_]+)'/g)];
    ok(selfPins.length === 0, 'S1 本文件零 build 轮次字面量（G-6）', selfPins.map((m) => m[1]).join(',') || '0 处');
    ok(/zx_\d{8}/.test(SELF_ROUND) && fs.existsSync(path.join(root, `plans/improve/${SELF_ROUND}.md`)),
      'S2 ★由载体自身派生：本轮方案文件在场', `plans/improve/${SELF_ROUND}.md`);
    ok(fs.existsSync(path.join(root, `scripts/rr_${SELF_ROUND}_pricing.ts`)),
      'S3 本套件在册（脚本名由载体派生）', `scripts/rr_${SELF_ROUND}_pricing.ts`);

    checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });
  }
}

main().catch((e: unknown) => {
  console.error(`\n💥 rr_zx_20261005_pricing 未捕获异常（复跑**未跑完**，不得读作通过）：`, e);
  fail++;
}).finally(() => {
  console.log(`\n${fail === 0 ? '✅' : '❌'} rr_zx_20261005_pricing: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
});
