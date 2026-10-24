/**
 * zx_20260910_5 受控复跑（「费用上限」名实相符：从虚名到真闸）。
 *
 * 病：`费用上限` 只被**注入提示词**、从不被判定（真库证据 E1/E2/E3），是一个"看起来有上限其实没有"的虚名；
 *     同一段 `<budget-context>` 的档位说明写 70%/95%，真源却是 60/75/95/98（E7/E8）；
 *     token 侧跨 resume 累计还重复计入（X5），使"使用比"可超 2000%。
 * 修：M1 费用真闸（累计→ratio→并 band→真禁工具）／M1b X5 单计数／M2 文案归正／M2b 任务级预算死输入补齐。
 *
 * 断言分两类：
 *   S0  **行为探针**——动态 import 真实模块，验证真源函数 `budgetBandOf` 的档位边界（实践论：不靠"源码里有"交差）。
 *   S1–S8 **源断言**——静态扫描；注释一律先 stripComments 再比对，避免本轮新增注释里引用的字面量制造假阳性
 *        （zx_20260910_3 / _4 已两次踩此坑）。
 *
 * 本文件不连任何 DB（真库实证见 data/baseline_zx_20260910_5.json 与方案 §5.3）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkBuildPins } from './lib/rr-pins.js';
import { engineSrcFiles, stripStepScopePrefix } from './lib/rr-engine-src.js';

let pass = 0; let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
const ROOT = path.join(__dirname, '..');
const rd = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf-8');
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const count = (s: string, re: RegExp) => (s.match(re) || []).length as number;

const EXE = 'apps/worker-ant-desktop/src/main/core/agent-executor.ts';
// zx_20260921 M8: `executeTask` 按职责拆出 `core/exec-*.ts`（含**预算段** `exec-budget.ts`）⇒
//   凡本意是"某功能的实现必须经由某个写口"（落在哪个文件只是当时的落点）的判据，扫描面取
//   「执行体 ∪ `core/exec-*.ts`」；目录约定**一处真源**在 `lib/rr-engine-src.ts`。
//   ⚠ 只许更严（横跨两处，任一处违例即红）；**文件名本身就是判据**的那类不得改用它（会变松）。
const exeRaw = engineSrcFiles().map((p) => fs.readFileSync(path.join(ROOT, p), 'utf-8')).join('\n');
// zx_20260929 M9: 再还原一层——步回调搬到 `core/exec-step.ts` 后段内绑定统一前置了 `d.`，
//   本套件大批针脚写的是搬迁前的字面量（`/const costRatio = costGateActive && maxCost > 0 …/` 等）。
//   还原 ≠ 放宽（见 `lib/rr-engine-src.ts` 的 `stripStepScopePrefix`）。
const exe = stripComments(stripStepScopePrefix(exeRaw));
const budgetBlock = (exe.match(/<budget-context>[\s\S]*?<\/budget-context>/) || [''])[0];

(async () => {
  console.log('S0 行为探针：真实 budgetBandOf 的档位边界（非静态扫描）');
  {
    try {
      const mod = await import(pathToFileURL(path.join(ROOT, EXE)).href) as { budgetBandOf?: (r: number) => number };
      const f = mod.budgetBandOf;
      ok(typeof f === 'function', '★真源函数 budgetBandOf 已导出且可 import（单一档位真源在位）');
      if (typeof f === 'function') {
        const cases: Array<[number, number]> = [[0, 1], [0.59, 1], [0.60, 2], [0.74, 2], [0.75, 3], [0.94, 3], [0.95, 4], [0.97, 4], [0.98, 5], [1.5, 5]];
        const bad = cases.filter(([r, want]) => f(r) !== want);
        ok(bad.length === 0, `★档位边界 0/59/60/74/75/94/95/97/98/150% 全对（${cases.length} 例）`,
          bad.length ? `不符: ${bad.map(([r, w]) => `${r}→${f(r)}(want ${w})`).join(', ')}` : '');
      }
    } catch (e) {
      ok(false, '★真源函数 budgetBandOf 可 import', (e as Error).message);
    }
  }

  console.log('S1 费用累计真存在（防"只加变量不累加"）');
  {
    ok(/let totalCostUsed = 0;/.test(exe), '声明 totalCostUsed（本次执行局部变量）');
    ok(/totalCostUsed = Number\(prevCtx\.cost_used\) \|\| 0;/.test(exe), '★跨 resume 从 ctx.cost_used 恢复（与 token 侧同口径）');
    ok(/totalCostUsed \+= stepCostCny;/.test(exe), '★真累加（+= ，非只声明）');
    ok(/const stepCostCny = Math\.round\(stepCost \* cnyFactor\(modelName\) \* 1_000_000\) \/ 1_000_000;/.test(exe),
      '★累加值与发往 ANS 记账的 cost 同一折算（闸内累计 = 账单，账实相符）');
  }

  console.log('S2 band 合并真存在（防"算了不判"）');
  {
    ok(/export function budgetBandOf\(ratio: number\): number \{/.test(exe), '档位骨架提取为单一真源导出函数（消除两处重复三元式）');
    ok(/const costRatio = costGateActive && maxCost > 0 \? \(cumCost \/ maxCost\) : 0;/.test(exe), '费用 ratio 计算在位');
    ok(/const tokenBand = budgetBandOf\(ratio\);/.test(exe) && /const costBand = budgetBandOf\(costRatio\);/.test(exe),
      '两闸各算各的 band（均走单一真源）');
    ok(/const band = Math\.max\(tokenBand, costBand\);/.test(exe), '★取较严者（任一先到即触发）');
    ok(/ctxJson\.budget_warn_band = band;/.test(exe), '合并后的 band 落库（判据被真实使用）');
  }

  console.log('S3 真闸动作在位（防退化为"只提示"）');
  {
    ok(/disabledTools\.add\(key\)/.test(exe), '★band 分支内真禁工具（disabledTools.add）');
    ok(/disableToolGracefully\(key,/.test(exe), '★并优雅告知（disableToolGracefully）');
    ok(count(exe, /disabledTools\.add\(/g) >= 3, '★多处真实禁用点（≥3：98% 全禁 / edit_file / 末步强制产出）',
      `${count(exe, /disabledTools\.add\(/g)} 处`);
  }

  console.log('S4 盲区如实（未定价模型不假装有闸）');
  {
    ok(/const costGateActive = maxCost > 0 && \(inputPricePer1k \+ outputPricePer1k\) > 0;/.test(exe), '闸成立条件显式判定');
    ok(/\[费用闸未生效\]/.test(exe), '★未定价时落 system 消息显式告知（不静默）');
    ok(/ctxJson\.cost_gate_active = costGateActive;/.test(exe), '闸状态落库');
    ok(budgetBlock.includes('费用闸不生效'), '★且对模型也如实说（提示词内按 costGateActive 条件追加）');
    const td = stripComments(rd('apps/worker-ant-desktop/renderer/src/pages/TaskDetailPage.tsx'));
    ok(td.includes('费用闸未生效'), '★GUI 同源提示（用户可见，不只落库）');
  }

  console.log('S5 X4 档位文案归正');
  {
    ok(budgetBlock.length > 0, '<budget-context> 块存在');
    ok(budgetBlock.includes('60%/75%'), '★块内含真源档位 60%/75%');
    ok(!budgetBlock.includes('70%时预警'), '★不再出现失实的「70%时预警」（防回退）');
    ok(/ratio >= 0\.98 \? 5 : ratio >= 0\.95 \? 4 : ratio >= 0\.75 \? 3 : ratio >= 0\.60 \? 2 : 1/.test(exe),
      '★档位真源（0.98/0.95/0.75/0.60）仍在（文案向真源看齐，真源未动）');
    ok(/const bandSrc = costBand > tokenBand \? '费用' : costBand < tokenBand \? 'Token' : 'Token\/费用'/.test(exe),
      '★触发源如实标注（防把费用触发说成 Token 触发）');
    ok(!/Token已用\$\{/.test(exe), '不再有硬编码「Token已用${…}」措辞（已换 bandSrc/bandPct）');
  }

  console.log('S6 防反向漂移（币种仍为 ¥）');
  {
    ok(budgetBlock.includes('费用上限: ¥'), '★budget-context 费用行仍为 ¥');
    ok(!budgetBlock.includes('费用上限: $'), '★未漂回 $');
    const pd = stripComments(rd('apps/worker-ant-desktop/renderer/src/pages/ProjectDetailPage.tsx'));
    const pp = stripComments(rd('apps/worker-ant-desktop/renderer/src/pages/ProjectsPage.tsx'));
    const td = stripComments(rd('apps/worker-ant-desktop/renderer/src/pages/TaskDetailPage.tsx'));
    ok(pd.includes('费用上限(¥)/任务'), '项目详情·展示行标签 (¥)/任务');
    ok(pp.includes('单任务费用上限¥(如3.6)'), '项目列表·编辑占位符 ¥');
    ok(td.includes('费用预算（¥ 人民币/任务）'), '任务详情·编辑标签 ¥（人民币/任务）');
  }

  console.log('S7 接口一致（GUI ↔ main 链路未断）');
  {
    // 项目级链：GUI 表单 → project.ipc → context_json.budget.* → maxCost
    const pipc = stripComments(rd('apps/worker-ant-desktop/src/main/ipc/project.ipc.ts'));
    ok(/budget\?: \{ max_tokens_per_task\?: number; max_cost_usd_per_task\?: number \}/.test(pipc),
      'project.ipc 仍声明 budget.max_cost_usd_per_task');
    //   ⚠ zx_20260921 M8（**判据形状订正**，非源码回退）：该段搬至 `core/exec-budget.ts`，第二实参名
    //     由 `budget` 变为 `projectBudget` ⇒ 判据认**两种实参名**。**不得**放宽成"只要调了这个函数就行"：
    //     第一实参仍须是任务级 `taskBudCtx`、第二实参仍须标着项目级预算的类型（"任务级 > 项目级 > 无"
    //     这条**次序**才是判据的本意）。
    ok(/const \{ maxCost, src: costSrc \} = resolveCostBudget\(taskBudCtx, (budget|projectBudget) as \{ max_cost_usd_per_task\?: number \}\);/.test(exe),
      '★引擎经 resolveCostBudget 解析上限（任务级 > 项目级 > 无）——zx_20260910_6 M1：来源成为一等公民');
    ok(/const p = Number\(projBudget\?\.max_cost_usd_per_task\);\n\s*if \(Number\.isFinite\(p\) && p > 0\) return \{ maxCost: p, src: 'project' \};/.test(exe),
      '★项目级 budget.max_cost_usd_per_task 仍是链路一环（且不再是无许诺者的兜底末位）');
    ok(!/modeApplied\.budget\.cost/.test(exe),
      '★原型默认金额兜底已删除（从未标定的常量不再冒充「用户设的上限」）');
    // M2b 任务级链：GUI「任务预算」编辑 → task:context → 任务 context_json → 引擎覆盖
    ok(/const taskBudCtx = \(\(\) => \{/.test(exe) && /max_cost_usd_per_task\?: number/.test(exe),
      '★M2b：引擎解析任务级预算（原为死输入）');
    //   ⚠ M8 同上：认 `projectBudget` / `modeBudget` 两种实参名（**三段的次序与兜底层级不变**）。
    ok(/let maxTokens = Number\(taskBudCtx\.max_tokens_per_task\) \|\| \((budget|projectBudget)\.max_tokens_per_task as number\) \|\| (modeApplied\.budget|modeBudget)\.tokens;/.test(exe),
      '★M2b：token 侧同为 任务级 > 项目级 > 原型默认');
    ok(/const merged = \{ \.\.\.\(JSON\.parse\(existing\.context_json \|\| '\{\}'\)\), \.\.\.context \};/.test(pipc),
      'M2b：task:context 仍是浅合并写入（GUI 保存路径未断）');
    ok(stripComments(rd('apps/worker-ant-desktop/renderer/src/lib/ipc.ts')).includes("'task:context'"),
      'M2b：renderer 仍经 task:context 调用（preload 通道未断）');
  }

  console.log('S8 X5 token 侧单计数（跨 resume 不再重复计入）');
  {
    ok(!/budgetAccumStart/.test(exe), '★代码中已无 budgetAccumStart（仅注释保留历史说明）');
    ok(/const cumUsed = totalTokensUsed;/.test(exe), '★累计改为单计数器（totalTokensUsed 恢复时已含历史）');
    ok(/ctxJson\.budget_accum = cumUsed;/.test(exe), 'budget_accum 仍写回（下游 legacy 版本探测仍读它）');
    ok(/const budgetRatioCum = maxTokens > 0 \? totalTokensUsed \/ maxTokens : 0;/.test(exe),
      '★步进实时 band 的 ratio 同为单计数（原先此处也双计）');
    ok(/const budgetBandNow = budgetBandOf\(budgetRatioCum\);/.test(exe),
      '步进 band 亦走单一真源（顺手消除一处判据分身）');
    ok(/estBiasPct: estTokens > 0 \? Math\.round\(\(totalTokensUsed \/ estTokens - 1\) \* 100\) : undefined,/.test(exe),
      'estBiasPct 分子同为单计数（与预算 ratio 同源）');
    // 订正（M5 落地时）：原为字面量钉 `build: 'zx_20260911_5'`（每开新轮须手改，逐轮滚长）。
    // 改为**派生一致性**：真源＝agent-executor.ts 的那一处 build 值；核对"恰好一处 + 格式合法 + 标签有据 + 全量钉子同值"。
    // 见 plans/improve/zx_20260912.md §M5 与 scripts/lib/rr-pins.ts。
    checkBuildPins(ok);
  }

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})();
