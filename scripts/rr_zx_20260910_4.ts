/**
 * zx_20260910_4 受控复跑（批次1：费用口径「币种名实相符」）。
 *
 * 病：同一个数 `0.5`，注入模型的提示词写 `$0.50`，而本仓成本自 zx_20260904_7 起统一按人民币(CNY)计费，
 *     GUI 六处全标 ¥。名（提示词说 $）与实（管线按 CNY）脱钩。
 * 修：提示词归正为 ¥（GUI 本就是对的，**不动**）。
 *
 * 本文件按"源断言"复核，全部只读源码、不连任何 DB：
 *   S1 `<budget-context>` 预算上下文用 ¥ 且不再出现 `$`（防回退到修复前）。
 *   S2 计费真源仍在（USD_TO_CNY_RATE / cnyFactor / currency:'CNY'）——确保"向 ¥ 看齐"有据可依。
 *   S3 GUI 六处费用展示**仍为 ¥**——防**反向漂移**（把 GUI 改去迁就错误的 $）。
 *   S4 字段名 `max_cost_usd_per_task` 为历史误名的注释在位——防后人"照名字修回去"。
 *
 * 注释一律先 stripComments 再比对：本轮新增的注释里就引用了 `$` / `currency:'CNY'` 等字面量，
 * 不剥离会把注释当成代码，制造假阳性（zx_20260910_3 已踩过这个坑）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { engineSrcFiles } from './lib/rr-engine-src.js';

let pass = 0; let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
const ROOT = path.join(__dirname, '..');
const rd = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf-8');
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const EXE = 'apps/worker-ant-desktop/src/main/core/agent-executor.ts';
// zx_20260921 M8: `executeTask` 按职责拆出 `core/exec-*.ts`（含**预算段** `exec-budget.ts`——
//   `maxCost` 的取值处随段搬走）⇒ 凡本意是"某功能的实现必须经由某个写口"的判据，扫描面取
//   「执行体 ∪ `core/exec-*.ts`」；目录约定**一处真源**在 `lib/rr-engine-src.ts`。⚠ 只许更严。
//   ⚠ 但**逐文件切分要留着**：S4 的护栏是"注释与取值处**同址**"（防后人照字段名把展示改回 $），
//     并成一个整串会把这个"同址"条件悄悄抹掉 ⇒ S4 另按文件找同址（见下）。
const surface = engineSrcFiles().map((p) => ({ p, raw: fs.readFileSync(path.join(ROOT, p), 'utf-8') }));
const exeRaw = surface.map((f) => f.raw).join('\n');
const exe = stripComments(exeRaw);

console.log('S1 预算上下文币种 = ¥（本轮靶心）');
{
  const block = (exe.match(/<budget-context>[\s\S]*?<\/budget-context>/) || [''])[0];
  ok(block.length > 0, '预算上下文块存在（<budget-context>…</budget-context>）');
  ok(block.includes('费用上限: ¥'), '★费用上限以 ¥ 告知模型（人民币口径）');
  ok(!block.includes('费用上限: $'), '★不再出现「费用上限: $」（防回退到修复前）');
  ok(/费用上限: ¥\$\{maxCost\.toFixed\(2\)\}/.test(block), '且仍插值真实 maxCost（未写死数字）');
}

console.log('S2 计费真源仍在（"向 ¥ 看齐"的据）');
{
  ok(/USD_TO_CNY_RATE\s*=\s*[\d.]+/.test(exe), 'USD→CNY 汇率常量在位');
  ok(/function cnyFactor\(/.test(exe) && /USD_TO_CNY_RATE\s*:\s*1/.test(exe), 'cnyFactor 折算函数在位（USD 计价模型折 CNY，境内模型原值）');
  const n = (exe.match(/currency:\s*'CNY'/g) || []).length;
  ok(n >= 3, `计费落库统一标记 currency:'CNY'（≥3 处：步进/收口/终态）`, `${n} 处`);
}

console.log('S3 GUI 六处费用展示仍为 ¥（防反向漂移）');
{
  const pd = stripComments(rd('apps/worker-ant-desktop/renderer/src/pages/ProjectDetailPage.tsx'));
  const pp = stripComments(rd('apps/worker-ant-desktop/renderer/src/pages/ProjectsPage.tsx'));
  const td = stripComments(rd('apps/worker-ant-desktop/renderer/src/pages/TaskDetailPage.tsx'));

  ok(pd.includes('费用上限(¥)/任务'), '项目详情·展示行标签为 (¥)/任务');
  ok(pd.includes('¥{ctx.budget.max_cost_usd_per_task'), '项目详情·展示行数值前缀 ¥');
  ok(pp.includes('单任务费用上限¥(如3.6)'), '项目列表·编辑占位符标 ¥');
  // zx_20260910_5 订正：断言改为钉「币种标记」而非逐字文案——zx_20260910_5 把成本卡改名为
  // 「费用（¥ 人民币）· 已用/上限」（新增费用水位），逐字断言会「每轮必误报」。护栏意图（必须是 ¥，不许漂 $）不变。
  ok(/（¥ 人民币）/.test(td), '任务详情·费用明标（¥ 人民币）');
  ok(td.includes('费用预算（¥ 人民币/任务）'), '任务详情·费用预算明标（¥ 人民币/任务）');
  ok(/¥\$\{ctxForm\.max_cost_usd_per_task\}/.test(td), '任务详情·上限行以 ¥ 呈现');

  // 反向漂移护栏：两处渲染色必须紧随 ¥ 之后。
  // 项目详情是 JSX（`¥{…}`，$ 若被写进 JSX 文本会变成 `${…}`）；任务详情是模板串（`¥${…}`，漂移形态为 `$${…}`）。
  ok(!/\$\{ctx\.budget\.max_cost_usd_per_task/.test(pd), '项目详情·未把该字段改标 $（反向漂移护栏）');
  ok(!/\$\$\{ctxForm\.max_cost_usd_per_task/.test(td), '任务详情·未把该字段改标 $（反向漂移护栏）');
}

console.log('S4 历史误名约束注释在位（防"照名字修回去"）');
{
  ok(exeRaw.includes('历史误名'), 'maxCost 取值处注明「字段名 max_cost_usd_per_task 是历史误名」');
  ok(exeRaw.includes('勿据字段名把展示改回 $'), '并写明禁止按字段名回改 $');
  // M8：上面两条并集口径只能证"注释在扫描面里"。真正的护栏是**注释与取值处同址**——
  //   若注释净留在 `agent-executor.ts` 而取值搬去了 `exec-budget.ts`，护栏就名存实亡。按文件找同址。
  const sameSite = surface.filter((f) => f.raw.includes('历史误名') && /resolveCostBudget\(/.test(f.raw));
  ok(sameSite.length > 0, '★且与取值处**同址**（同一文件内同时含注释与 `resolveCostBudget(` 调用）',
    sameSite.length ? sameSite.map((f) => path.relative(ROOT, f.p)).join(', ') : '注释与取值处不在同一文件');
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
