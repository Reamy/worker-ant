/**
 * zx_20260913 轮级收口受控复跑（「最后一公里：到得了 · 归得对 · 跑得起来」+ Token 低风险降本）。
 *
 * 本文件是**轮级收口**，不复述 M1–M4 的逐项断言（那在 `rr_zx_20260913_1..4.ts` 各自的 92/74/163/103 断言里）。
 * 它只做四件事：
 *   S1–S6 build 标识的**派生一致性**——承 zx_20260912 M5 已确立的「一处真源 + rr 侧派生」机制
 *         （病根与改法见 plans/improve/zx_20260913.md §M5 与 scripts/lib/rr-pins.ts）；
 *   S7 基线归档在册——`data/baseline_zx_20260913.json`（M0 五项证据 + 收口 `closingWatermark`；
 *        收口样本如实记「本轮构建尚未跑过真实任务」这一事实，不臆造对比）；
 *   S8 整轮不变式（跨 M1–M4 的四条）：
 *       ①跨进程共享真源（本轮新增/改动的零依赖模块在 renderer 侧真的同引）；
 *       ②M1-4 失败记账**单点**（通知记账点一处 + 手动重发一处；其余 7 处成功 INSERT 靠列 DEFAULT，不手抄）；
 *       ③四条里程碑 rr 脚本在册；
 *       ④**T1 红线**（prompt caching 架构改造本轮不做 ⇒ 源码无 cache 参数；挂账仍如实）。
 *
 * 断言两类（承 zx_20260911_2 §九 与 feedback「往返/闭环类判据须在生产入参上证」）：
 *   静态断言一律 `stripKeepingLines`/`stripComments` 后再比对，防注释里的关键词造成假阳性
 *   （**本轮实测踩到过**：`blob.includes('zx_…')` 会被注释里的轮次名骗绿——故产物判据取 build **值本身**）；
 *   行为断言动态 import **真实现**（`deriveBuildTag`/`scanBuildPins`/`checkBuildPins`/`listStrayPinLiterals`）。
 *
 * ⚠ S3/S4 读 `dist` ⇒ **tsup 必须先于本脚本**。
 * ⚠ 本文件不打开任何真库（真库只读实测见 data/baseline_zx_20260913.json）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  checkBuildPins, deriveBuildTag, scanBuildPins, listStrayPinLiterals, stripKeepingLines,
} from './lib/rr-pins.js';
// S8① 的产物证据要按**当前词表**核产物，故标记从真源**派生**而非手抄（改取值则断言随之改，不会假绿）
import { ACCEPTANCE_TYPES } from '../apps/worker-ant-desktop/src/main/core/deliverable-types.js';
import { depBlockInfo } from '../apps/worker-ant-desktop/src/main/core/dep-graph.js';

let pass = 0; let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (a: unknown, b: unknown, l: string) => ok(JSON.stringify(a) === JSON.stringify(b), l, `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);

const ROOT = path.join(__dirname, '..');
const SCRIPTS = path.join(ROOT, 'scripts');
const A = 'apps/worker-ant-desktop';
const SRC = path.join(ROOT, `${A}/src/main/core/agent-executor.ts`);
const DIST = path.join(ROOT, `${A}/dist`);
const PLANS = path.join(ROOT, 'plans/improve');
const RD = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf-8');
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const realSrc = fs.readFileSync(SRC, 'utf-8');
const { tag } = deriveBuildTag(realSrc);

// 夹具字面量刻意经 q() 拼接：夹具是**数据**，不是本扫描器要核的"钉子"。
// 直接写死会让本脚本自身被扫成"残留钉子"（S5 必红）——这是"扫全量"的必然代价，如实处理，不为此放宽扫描面。
const q = (s: string) => "'" + s + "'";

/** 收集式 ok：把 checkBuildPins 的播报收进内存，供"点名某一条判据"用。 */
function collect(): { rec: Array<{ cond: boolean; label: string; detail: string }>; sink: (c: boolean, l: string, d?: string) => void } {
  const rec: Array<{ cond: boolean; label: string; detail: string }> = [];
  return { rec, sink: (cond, label, detail) => { rec.push({ cond, label, detail: detail ?? '' }); } };
}

// ══════════════════════════════════════════════════════════════════════
// S1 派生化：真源码单一真源 + 人造双值必被计数
// ══════════════════════════════════════════════════════════════════════
console.log('\n[S1 派生化：真源码单一真源 + 人造双值必被计数]');
{
  const d = deriveBuildTag(realSrc);
  ok(d.count === 1 && d.tag === tag, `真源码 build 轮次标识恰好 1 处（${d.tag}）`, `count=${d.count}`);
  // 订正（zx_20260914 M4-1，**非回归**）：此行原为 `eq(tag, 'zx_20260913', …)` —— 一个**硬编码轮次字面量**。
  // `scanBuildPins` 的 PIN_RE 只认 `build:`/`ROUND =`/`includes(` 前缀，故它躲过了 P5、成为只为下一轮设的哑雷：
  // 下一轮刷新真源后本脚本必红，而"红"与"真的退化"无从区分 ⇒ 旧轮脚本只能被弃用。
  // 改为**由本脚本自身文件名派生**的单调守卫：真源标签只许**不早于**本脚本轮次（刷新后仍成立，永不随轮停更）。
  const thisRound = (path.basename(__filename).match(/^rr_(zx_\d{8}(?:_\d+)?)/) || [])[1] || '';
  // zx_20260922 收口：此行原为 `thisRound === 'zx_20260913'` —— 与行内标签「不写字面量」**自相矛盾**
  //   （派生之后又拿字面量去比）。它虽不随轮引爆（文件名冻结），但名实不符，且下一行的方向性比较
  //   `tag >= thisRound` 已把该证的事证全。改为只证"派生成功"。
  ok(thisRound.length > 0 && thisRound.startsWith('zx_'), '本脚本轮次由文件名派生成功（判据内不写轮次字面量）', thisRound);
  ok(tag >= thisRound, `真源标签 ${tag} 不早于本脚本轮次 ${thisRound}（M5 已刷新则同轮、后续轮次则更新）`);
  eq(deriveBuildTag(`const a = { build: ${q('zx_19000101')} };\nconst b = { build: ${q('zx_20000202')} };\n`).count, 2,
    '人造"陈旧第二值"源 → count=2（计数判据非空转）');
  ok(realSrc.includes('rr 侧**不再手抄本行值**'), '源码写值处仍带"rr 侧不再手抄本行值"纪律注记（承 0912 M5，勿删）');
}

// ══════════════════════════════════════════════════════════════════════
// S2 扫描器自检：真钉认得出、注释与自轮常量不误认、行号可定位
// ══════════════════════════════════════════════════════════════════════
console.log('\n[S2 扫描器：真钉认得出、注释与自轮常量不误认、行号可定位]');
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-pins-scan-'));
  fs.writeFileSync(path.join(tmp, 'rr_fixture_ok.ts'), [
    `const ROUND = ${q('zx_11010101')};`,            // L1 前向钉（真钉）
    `const PREV_ROUND = ${q('zx_10990101')};`,       // L2 自轮常量 → 词界豁免
    `// ok(/build: ${q('zx_20990101')}/.test(x));`,  // L3 注释里的假钉 → 必须不计
    `ok(/build: ${q('zx_11010101')}/.test(x));`,     // L4 前向钉
    `ok(!/build: ${q('zx_10990102')}/.test(x));`,    // L5 反向钉
  ].join('\n') + '\n');
  const pins = scanBuildPins(tmp, tmp);
  eq(pins.map((p) => [p.line, p.kind, p.value]),
    [[1, 'forward', 'zx_11010101'], [4, 'forward', 'zx_11010101'], [5, 'reverse', 'zx_10990102']],
    '只认真钉：行号 / 前反向 / 取值全对');
  ok(!pins.some((p) => p.value === 'zx_20990101'), '注释里的假钉未被计入（防假阳性）');
  ok(!pins.some((p) => p.value === 'zx_10990101'), '自轮常量 PREV_ROUND 未被计入（词界豁免）');
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ══════════════════════════════════════════════════════════════════════
// S3 全量现状：P1–P6 全绿（8 条判据，含产物同值）
// ══════════════════════════════════════════════════════════════════════
console.log('\n[S3 全量现状：P1–P6 全绿（8 条判据，含产物同值）]');
{
  const { rec, sink } = collect();
  checkBuildPins(sink, { distDir: DIST });
  eq(rec.length, 8, 'P1–P6 共 8 条判据在册');
  ok(rec.every((r) => r.cond), 'P1–P6 全绿', rec.filter((r) => !r.cond).map((r) => `${r.label}：${r.detail}`).join('｜'));
  ok(rec.some((r) => r.label.includes('产物内 build 值与源码同值')), '其中含"产物 build 值与源码同值"（真源已烧进产物）');
  ok(rec.some((r) => r.label.includes('复跑脚本在册')), '其中含"复跑脚本在册"（P4：本文件自身即其凭据）');
}

// ══════════════════════════════════════════════════════════════════════
// S4 反证非空转：改一处即红，且点名 file:line
// ══════════════════════════════════════════════════════════════════════
console.log('\n[S4 反证非空转：改一处即红，且点名 file:line]');
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-pins-bad-'));
  // (a) 人造双值源 → P1 必须红
  const badSrc = path.join(tmp, 'synthetic-executor.ts');
  fs.writeFileSync(badSrc, `const a = { build: ${q('zx_19000101')} };\nconst b = { build: ${q('zx_20000202')} };\n`);
  const a = collect();
  checkBuildPins(a.sink, { rootDir: tmp, srcPath: badSrc, scriptsDir: tmp, plansDir: PLANS });
  const p1 = a.rec.find((r) => r.label.includes('恰好 1 处'));
  ok(!!p1 && p1.cond === false, '人造双值源 → P1「恰好 1 处」判红', p1 ? p1.detail : '(未播报)');

  // (b) 前向钉取值不对 → P5 前向必须红，且 detail 点名 file:line
  fs.writeFileSync(path.join(tmp, 'rr_fixture_bad.ts'), `ok(/build: ${q('zx_11010101')}/.test(x));\n`);
  const b = collect();
  checkBuildPins(b.sink, { rootDir: tmp, srcPath: SRC, scriptsDir: tmp, plansDir: PLANS });
  const p5f = b.rec.find((r) => r.label.includes('全量前向钉均等于真源'));
  ok(!!p5f && p5f.cond === false && p5f.detail.includes('rr_fixture_bad.ts:1'),
    '取值不对的前向钉 → P5 判红并点名 file:line', p5f ? p5f.detail : '(未播报)');

  // (c) 反向钉被写成真源值 → P5 反向必须红
  fs.writeFileSync(path.join(tmp, 'rr_fixture_bad.ts'), `ok(!/build: '${tag}'/.test(x));\n`);
  const c = collect();
  checkBuildPins(c.sink, { rootDir: tmp, srcPath: SRC, scriptsDir: tmp, plansDir: PLANS });
  const p5r = c.rec.find((r) => r.label.includes('全量反向钉均不等于真源'));
  ok(!!p5r && p5r.cond === false, '反向钉写成真源值 → 反向判据判红', p5r ? p5r.detail : '(未播报)');
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ══════════════════════════════════════════════════════════════════════
// S5 字面量清零：rr 脚本里不再有待维护的轮次字面量
// ══════════════════════════════════════════════════════════════════════
console.log('\n[S5 字面量清零：rr 脚本里不再有待维护的轮次字面量]');
{
  eq(listStrayPinLiterals(SCRIPTS, ['rr_zx_20260909_fixes.ts'], ROOT), [],
    '除历史负钉外，rr 脚本无任何 build 轮次字面量（下一轮开新轮只需改源码一处）');
  const all = scanBuildPins(SCRIPTS, ROOT);
  eq(all.length, 1, '全量 rr 脚本仅剩 1 处钉');
  eq([all[0]!.kind, path.basename(all[0]!.file)], ['reverse', 'rr_zx_20260909_fixes.ts'],
    '该处即 09_fixes 的历史负钉（反向；其"钉格式不钉轮次"的改法正是先例）');
  ok(all[0]!.value !== tag, '历史负钉取值非本轮（不会与本轮真源混淆）');
}

// ══════════════════════════════════════════════════════════════════════
// S6 接线在册：派生模块被 14 个脚本真实调用（防"写了没用上"）
// ══════════════════════════════════════════════════════════════════════
console.log('\n[S6 接线在册：派生模块被 14 个脚本真实调用（防"写了没用上"）]');
{
  ok(fs.existsSync(path.join(SCRIPTS, 'lib/rr-pins.ts')), 'scripts/lib/rr-pins.ts 在位');
  const wired = [
    'rr_zx_20260910_3_b5.ts', 'rr_zx_20260910_5.ts', 'rr_zx_20260910_6.ts',
    'rr_zx_20260911_1.ts', 'rr_zx_20260911_2.ts', 'rr_zx_20260911_3.ts',
    'rr_zx_20260911_4.ts', 'rr_zx_20260911_5.ts', 'rr_zx_20260912.ts',
    // 本轮新增：M5 把 build 闸接进四个子脚本（对齐 0911 轮"每个子脚本自带 build 闸"的约定）
    'rr_zx_20260913.ts', 'rr_zx_20260913_1.ts', 'rr_zx_20260913_2.ts',
    'rr_zx_20260913_3.ts', 'rr_zx_20260913_4.ts',
  ];
  const missing = wired.filter((f) => !RD(`scripts/${f}`).includes("from './lib/rr-pins.js'") || !RD(`scripts/${f}`).includes('checkBuildPins('));
  eq(missing, [], `14 个脚本均已 import 且调用 checkBuildPins（实测 ${wired.length - missing.length}/${wired.length}）`);
}

// ══════════════════════════════════════════════════════════════════════
// S7 基线归档在册：M0 五项证据 + 收口 closingWatermark
// ══════════════════════════════════════════════════════════════════════
console.log('\n[S7 基线归档在册：data/baseline_zx_20260913.json]');
{
  const bp = path.join(ROOT, 'data/baseline_zx_20260913.json');
  ok(fs.existsSync(bp), '基线文件在位');
  const base = JSON.parse(fs.readFileSync(bp, 'utf-8')) as Record<string, unknown>;
  eq(base.round, 'zx_20260913', '基线 round 正确');
  const ev = base.evidence as Record<string, unknown>;
  for (const k of ['dbCounts', 'dbFacts', 'codeEnumerations', 'settledM0_3', 'contextWatermarkBaseline']) {
    ok(ev[k] !== undefined, `M0 证据段在册：evidence.${k}`);
  }
  const cw = base.closingWatermark as Record<string, unknown> | undefined;
  ok(!!cw, '收口段 closingWatermark 在册（M5-3 归档）');
  if (cw) {
    ok(cw.measuredUnderThisBuild === false, '如实记载：收口时**本轮构建尚未跑过真实任务**（桌面未重启，无新样本）', String(cw.note ?? ''));
    ok(Array.isArray(cw.samplesFromPriorBuilds) && (cw.samplesFromPriorBuilds as unknown[]).length > 0,
      'M0 口径的历史样本如实附上（非空）');
    eq(cw.gapNote !== undefined, true, '口径缺口（不含工具 schema）如实标注');
  }
}

// ══════════════════════════════════════════════════════════════════════
// S8 整轮不变式（跨 M1–M4）
// ══════════════════════════════════════════════════════════════════════
console.log('\n[S8 整轮不变式：跨进程共享真源 / M1-4 单点记账 / 里程碑在册 / T1 红线]');
{
  // ① 跨进程共享真源：本轮新增/改动的零依赖模块，renderer 源码真的跨 root 引
  const RDR = 'renderer/src';
  const shared = [
    { mod: 'dep-graph', consumers: [`${A}/${RDR}/pages/TaskDetailPage.tsx`, `${A}/${RDR}/pages/TasksPage.tsx`] },
    { mod: 'deliverable-types', consumers: [`${A}/${RDR}/pages/DeliverablesPage.tsx`, `${A}/${RDR}/pages/TaskDetailPage.tsx`] },
    { mod: 'settings-bool', consumers: [`${A}/${RDR}/pages/DeliverablesPage.tsx`, `${A}/${RDR}/pages/TasksPage.tsx`] },
  ];
  for (const s of shared) {
    const bad = s.consumers.filter((f) => !RD(f).includes(`src/main/core/${s.mod}.js`));
    eq(bad, [], `renderer 跨 root 引共享真源 ${s.mod}.ts（${s.consumers.length} 处消费全部在册）`);
  }
  // 跨进程同源的**产物证据**。注意：模块被 vite 放进哪个 chunk 是**打包器排布细节**，随 import 图变化——
  // zx_20260914 M2-4 让 `DeliverableDrawer` 同引 `deliverable-types`（D2 裁定：验收入口放列表行+抽屉），
  // 而抽屉经 `lib/deliverableDrawer`→`CommandPalette` 在**入口可达**路径上 ⇒ 该模块被收编进入口 chunk、
  // 不再单列 `deliverable-types-*.js`。旧断言把"恰好单列成 chunk"当不变式，会把**合法排布变化报成回归**。
  // 故改锚在真正的不变式上：**代码真在产物里，且全 dist 只一份副本**（同源 = 同一份实现，不是两份拷贝）。
  const assetsDir = path.join(ROOT, `${A}/renderer/dist/assets`);
  const assets = fs.existsSync(assetsDir) ? fs.readdirSync(assetsDir) : [];
  const readAsset = (f: string) => fs.readFileSync(path.join(assetsDir, f), 'utf-8');
  const jsAssets = assets.filter((f) => f.endsWith('.js'));
  ok(jsAssets.length > 0, 'renderer 产物存在 js chunk（renderer build 须先于本脚本）', `${jsAssets.length} 个`);
  // dep-graph 的实现本体确在产物里，且**全 dist 恰一份**、由两个懒加载页共同 import（真正共享）。
  // ★zx_20261029_3 M4 改锚：旧断言认文件名前缀 `dep-graph-*.js`，而 chunk 名是打包器给共享模块起的名字，
  //   随 import 图变化——本轮新增 `lib/task-source.ts` 后，两页共用的同一块被命名为 `task-source-*`，
  //   旧判据把**合法排布变化**报成回归。改锚在由真源**派生**的文案指纹（文件名是排布细节，实现本体是
  //   模块指纹），并加钉「两页共引该 chunk」——比"恰好叫 dep-graph"更强：既证明代码真在产物里，
  //   又证明它仍是**共享**而非各页内联一份。
  const depProbeId = '__dep_probe_missing__';
  const depMark = depBlockInfo([depProbeId], () => undefined, () => '').text.split(depProbeId).pop() ?? '';
  ok(depMark.length > 8, 'dep-graph 文案指纹可由真源派生（非手抄字面量）', JSON.stringify(depMark));
  const depHolders = jsAssets.filter((f) => readAsset(f).includes(depMark));
  ok(depHolders.length === 1,
    'renderer 产物含 dep-graph 实现本体且全 dist 恰一份副本（同一份实现，非每页一份拷贝）',
    `${depHolders.join(',') || '(未找到)'}`);
  const depChunkRef = depHolders.length === 1 ? `./${depHolders[0]}` : '';
  const depImporters = depChunkRef ? ['TasksPage', 'TaskDetailPage'].filter((p) => {
    const pageChunk = jsAssets.find((f) => f.startsWith(`${p}-`) && f.endsWith('.js'));
    return !!pageChunk && readAsset(pageChunk).includes(depChunkRef);
  }) : [];
  eq(depImporters, ['TasksPage', 'TaskDetailPage'],
    'dep-graph 所在 chunk 被列表页与详情页共同 import（跨页共享真源的机器证据）');
  // deliverable-types：标记**从真源派生**（`["doc","code"]` 去掉方括号）。
  // ★zx_20260929 M7 订正：该字面量**已不再是模块指纹**——成果页的类型下拉
  //   `['daemon','mcp','a2a','ui','doc','code']` 被打包后同样含子串 `"doc","code"`
  //   （合法排布变化，非回归）。故标记改锚在**判据实现本体** `.includes(String(` 上：
  //   页面的字符串数组不会有它，只有 isAcceptanceType/isPreviewType 的实现会。
  const accMark = JSON.stringify(ACCEPTANCE_TYPES).slice(1, -1);
  const accHolders = jsAssets.filter((f) => readAsset(f).includes(accMark));
  ok(accHolders.length >= 2,
    '反证：数据字面量已被页面下拉复用（≥2 chunk）⇒ 它不再是模块指纹，旧判据"恰一份"会把合法排布报成回归',
    `${accHolders.join(',') || '(未找到)'}；标记 ${accMark}`);
  const holders = jsAssets.filter((f) => readAsset(f).includes('includes(String('));
  ok(holders.length === 1, '共享类型词表**判据实现本体**在 renderer 产物内且**全 dist 恰一份副本**（同一份实现，非每 chunk 一份拷贝）',
    `${holders.join(',') || '(未找到)'}`);
  ok(holders.length === 1 && readAsset(holders[0]!).includes(accMark),
    '该副本同时含 ACCEPTANCE_TYPES 数据字面量与判据实现（isAcceptanceType/isPreviewType 的 includes(String(…)) 形态，两件同落一处）',
    `${holders[0] ?? ''}；标记 ${accMark}`);

  // ② M1-4 失败记账单点：failed 对话行恰**三**处（通知记账点 + 手动重发 + 机器回话失败），
  //    其余成功 INSERT 靠列 DEFAULT 不手抄。
  //    zx_20260920 M2 由两处增到三处：机器回话失败（`ctx.sendReply` 构造处）此前只 console.warn、
  //    对话视图里连一行都没有 ⇒ 多的是**第三个写者**，不是把哪一处拆成两处。
  const IM_FILES = [
    `${A}/src/main/core/im/im-outbox.ts`,
    // zx_20260920 M2: 机器回话失败的唯一记账点（落 failed 行、**不入 outbox** —— D4）。
    `${A}/src/main/core/im/reply-accounting.ts`,
    // zx_20260914 M1-1: 手工回话的成功 INSERT 迁入 manual-send.ts（真源一处，rr 可直接跑真函数）。
    // 扫描面必须跟着写入者走——漏一个文件，"恰三处"就只是"在我看的地方恰三处"。
    `${A}/src/main/core/im/manual-send.ts`,
    `${A}/src/main/ipc/im.ipc.ts`,
    `${A}/src/main/services/im-router.ts`,
    `${A}/src/main/services/wechat-adapter.ts`,
    `${A}/src/main/services/dingtalk-adapter.ts`,
    `${A}/src/main/services/wecom-adapter.ts`,
    `${A}/src/main/services/feishu-adapter.ts`,
    `${A}/src/main/services/qqbot-adapter.ts`,
    // zx_20260930 M2-c: 出站行的**唯一落点**（五家适配器那 9 处内联 INSERT 已全部迁入此处）。
    //   扫描面必须跟着写入者走——本轮它若不进来，"适配器零内联"就只是"在我看的地方零内联"。
    `${A}/src/main/core/im/outbound-record.ts`,
  ];
  const insertLines: Array<{ file: string; line: string }> = [];
  for (const f of IM_FILES) {
    for (const l of stripKeepingLines(RD(f))) {
      if (l.includes('INSERT INTO wa_im_conversations')) insertLines.push({ file: path.basename(f), line: l });
    }
  }
  // zx_20260929 M8-c 订正（改钉更强的真源，非放宽）：失败行的 status **已不再以字面量
  //   `'failed'` 落纸**——`blocked_quota`/`failed` 两个取值同走绑定参数。旧判据按 `'failed'`
  //   子串找"失败行写者"，M8-c 一改就只剩 im-outbox 一家（另两家的值在参数里）。
  //   改以**是否显式写 status 列**为据：列 DEFAULT='sent' 只管成功行 ⇒ 写 status 列者=失败行写者。
  const statusWriters = insertLines.filter((x) => /\bstatus\b/.test(x.line));
  eq(statusWriters.map((x) => x.file).sort(), ['im-outbox.ts', 'im.ipc.ts', 'reply-accounting.ts'],
    'failed 对话行写入**恰三处**：通知记账点(im-outbox) + 手动重发失败(im.ipc) + 机器回话失败(reply-accounting)（以"写 status 列"为据）');
  eq(statusWriters.length, 3, '显式写 status 列的 INSERT 恰 3 处（其余靠列 DEFAULT=\'sent\' ⇒ 一处真源，非手抄清单）');
  // zx_20260930 M2-c（**改钉更强的真源，非放宽**）：出站行的形状由"五家各写一份"收成**一处**。
  //   旧判据是"扫描面里 INSERT 读点 ≥10"——本轮那 9 处内联迁走后该数**必然**下跌，故不能只调数字：
  //   数字只证"扫到东西了"，真正要钉的是**形状**（适配器零内联 + 落点含 task_id）。
  const ADAPTER_FILES = ['wechat', 'dingtalk', 'wecom', 'feishu', 'qqbot'].map((n) => `${A}/src/main/services/${n}-adapter.ts`);
  eq(ADAPTER_FILES.filter((f) => RD(f).includes('INSERT INTO wa_im_conversations')), [],
    '五家适配器**零内联**出站 INSERT（出站行已迁入 `outbound-record.ts` 单一落点）');
  ok(/INSERT INTO wa_im_conversations[\s\S]{0,200}?task_id/.test(RD(`${A}/src/main/core/im/outbound-record.ts`)),
    '落点那一句 INSERT 的**列清单含 task_id**（M2-c 靶心：这一行现在答得出"属于哪个任务"）');
  ok(insertLines.length >= 8,
    `对话表 INSERT 读点下界成立（实测 ${insertLines.length} ≥ 8；五家适配器 9 处内联 → outbound-record 1 处，净减 8）`);
  // 反证：任一 INSERT 若手抄 status='sent'，即与"成功行靠列 DEFAULT 一处真源"相冲
  ok(!insertLines.some((x) => x.line.includes("'sent'")),
    '反证：对话 INSERT 无一手写 status=\'sent\'（送达态一处真源 = 列 DEFAULT；手抄清单即红）');
  // 单点记账的本体：enqueueImOutbox 体内同时有 outbox INSERT 与 failed 对话行写入
  const outboxSrc = stripKeepingLines(RD(IM_FILES[0]!)).join('\n');
  const body = outboxSrc.slice(outboxSrc.indexOf('export function enqueueImOutbox'));
  ok(body.includes('INSERT INTO wa_im_outbox') && body.includes('recordFailedConversation(db, id, entry, error)'),
    'enqueueImOutbox 体内同写 outbox 与 failed 对话行（"一条通知没送到"的唯一记账点）');

  // ③ 四条里程碑 rr 脚本在册
  for (const n of [1, 2, 3, 4]) {
    const f = path.join(SCRIPTS, `rr_zx_20260913_${n}.ts`);
    ok(fs.existsSync(f) && fs.statSync(f).size > 5_000, `里程碑复跑脚本在册：rr_zx_20260913_${n}.ts`);
  }

  // ④ T1 红线：prompt caching 架构改造本轮**不做** ⇒ 源码无 cache 参数（挂账仍如实）
  const ae = stripComments(realSrc);
  ok(!/cache_control/.test(ae), 'T1 红线：源码无 cache_control 透传（§7.2 挂账未偷偷落地）');
  ok(!/providerOptions/.test(ae), 'T1 红线：streamText 调用未加 providerOptions（M4 只降本、不改调用架构）');
}

console.log(`\n结果: pass=${pass} fail=${fail}`);
process.exit(fail > 0 ? 1 : 0);
