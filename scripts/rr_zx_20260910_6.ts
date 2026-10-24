/**
 * zx_20260910_6 受控复跑（「金额上限」须有许诺者——费用闸只在有人许下时存在）。
 *
 * 病（zx_20260910_5 把「费用上限」从虚名改成真闸之后**才暴露**的第二层病）：
 *   真闸 + `ARCHETYPE_BUDGETS[archetype].cost`（一个从未标定的常量 ¥0.15–1.80）作末端兜底
 *   ⇒ 从未设过上限的任务被一个凭空数字硬停（真库事故：真实任务在约 7% token 预算处被 98% 硬收尾）。
 *   同源名实不符还有一处：`<budget-context>` 仍把该常量当"上限"写进提示词。
 *
 * 修（本体论 / 缘起性空）：上限是一个**承诺**，有许诺者才存在。
 *   M1 `resolveCostBudget` 让**来源**(task/project/none)成为一等公民；无许诺者 ⇒ maxCost=0（无闸），
 *      但费用照常累计落库（**没有上限 ≠ 没有账**）。
 *   M2 GUI 名实同步（TaskDetail / ProjectDetail / Projects 三页如实区分"有上限/无上限"）。
 *   M3 存量与边界：零迁移（从无 phantom 上限），事故任务改由用户在项目里自己填的 ¥2 把关。
 *   M4 说明书整块提为可测导出纯函数 `buildBudgetContextBlock`，三态在**渲染结果**上证。
 *
 * 断言分两类：
 *   S0  **行为探针**——动态 import 真实模块，验证 `resolveCostBudget` 三态与 `buildBudgetContextBlock`
 *       四种渲染结果（实践论：说明书说错了没有，只扫源码验不出来，必须在渲染结果上看）。
 *   S1–S9 **源/产物断言**——静态扫描；注释一律先 stripComments 再比对（zx_20260910_3/_4 已两次踩假阳性坑）。
 *
 * 本文件不连任何 DB（真库实证见 data/baseline_zx_20260910_6.json 与方案 §四 M3）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { checkBuildPins } from './lib/rr-pins.js';
import { engineSrcFiles, stripStepScopePrefix } from './lib/rr-engine-src.js';
import { pathToFileURL } from 'node:url';

let pass = 0; let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
const ROOT = path.join(__dirname, '..');
const rd = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf-8');
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const EXE = 'apps/worker-ant-desktop/src/main/core/agent-executor.ts';
const ARCH = 'apps/worker-ant-desktop/src/main/core/task-archetype.ts';
// zx_20260921 M8: `executeTask` 按职责拆出 `core/exec-*.ts`（含**预算段** `exec-budget.ts`）⇒
//   凡本意是"某功能的实现必须经由某个写口"的判据，扫描面取「执行体 ∪ `core/exec-*.ts`」；
//   目录约定**一处真源**在 `lib/rr-engine-src.ts`。⚠ 只许更严；"文件名本身就是判据"的那类不得改用它。
const exeRaw = engineSrcFiles().map((p) => fs.readFileSync(path.join(ROOT, p), 'utf-8')).join('\n');
// zx_20260929 M9: 再还原一层——步回调搬到 `core/exec-step.ts` 后段内绑定统一前置了 `d.`，
//   本套件针脚写的是搬迁前的字面量（`cost_used` 逐步回写等）。还原 ≠ 放宽（见 `stripStepScopePrefix`）。
const exe = stripComments(stripStepScopePrefix(exeRaw));
const arch = stripComments(rd(ARCH));
const TD = 'apps/worker-ant-desktop/renderer/src/pages/TaskDetailPage.tsx';
const PD = 'apps/worker-ant-desktop/renderer/src/pages/ProjectDetailPage.tsx';
const PP = 'apps/worker-ant-desktop/renderer/src/pages/ProjectsPage.tsx';
const td = rd(TD); const pd = rd(PD); const pp = rd(PP);

(async () => {
  console.log('S0 行为探针：resolveCostBudget 三态 + buildBudgetContextBlock 四种渲染结果（非静态扫描）');
  {
    const mod = await import(pathToFileURL(path.join(ROOT, EXE)).href) as {
      resolveCostBudget?: (t: { max_cost_usd_per_task?: number }, p: { max_cost_usd_per_task?: number }) => { maxCost: number; src: string };
      buildBudgetContextBlock?: (p: { maxTokens: number; maxCost: number; costSrc: 'task' | 'project' | 'none'; costGateActive: boolean }) => string;
    };
    const rc = mod.resolveCostBudget;
    const bb = mod.buildBudgetContextBlock;
    ok(typeof rc === 'function', '★真源函数 resolveCostBudget 已导出且可 import（来源成为一等公民）');
    ok(typeof bb === 'function', '★说明书函数 buildBudgetContextBlock 已导出且可 import（可测，不靠"源码里有"交差）');

    if (typeof rc === 'function') {
      const cases: Array<[string, { max_cost_usd_per_task?: number }, { max_cost_usd_per_task?: number }, number, string]> = [
        ['任务级优先于项目级', { max_cost_usd_per_task: 3 }, { max_cost_usd_per_task: 5 }, 3, 'task'],
        ['任务级缺省→回落项目级', {}, { max_cost_usd_per_task: 5 }, 5, 'project'],
        ['任务级为 0（=未设）→回落项目级', { max_cost_usd_per_task: 0 }, { max_cost_usd_per_task: 5 }, 5, 'project'],
        ['任务级非数 →回落项目级', { max_cost_usd_per_task: NaN }, { max_cost_usd_per_task: 5 }, 5, 'project'],
        ['任务级为负 →回落项目级', { max_cost_usd_per_task: -1 }, { max_cost_usd_per_task: 5 }, 5, 'project'],
        ['★两者皆无 → 0/none（不是上限）', {}, {}, 0, 'none'],
        ['★两者皆 ≤0 → 0/none', { max_cost_usd_per_task: 0 }, { max_cost_usd_per_task: 0 }, 0, 'none'],
        ['★P0 场景：任务级无值即不得凭空造上限', {}, { max_cost_usd_per_task: 0 }, 0, 'none'],
        ['数字字符串仍被接受', { max_cost_usd_per_task: '2.5' as unknown as number }, {}, 2.5, 'task'],
      ];
      const bad = cases.filter(([, t, p, want, wantSrc]) => { const r = rc(t, p); return r.maxCost !== want || r.src !== wantSrc; });
      ok(bad.length === 0, `★来源三态 ${cases.length} 例全对（无许诺者恒为 0/none）`,
        bad.length ? JSON.stringify(bad.map(([n]) => n)) : '');
    }

    if (typeof bb === 'function') {
      const render = (maxCost: number, costSrc: 'task' | 'project' | 'none', costGateActive: boolean) =>
        bb({ maxTokens: 1_200_000, maxCost, costSrc, costGateActive });

      const rNone = render(0, 'none', false);
      ok(!rNone.includes('费用上限: ¥'), '★未设上限：说明书**不提**"费用上限: ¥"（不得把没有的说成有）');
      ok(rNone.includes('未设置金额上限'), '★未设上限：如实写明"本任务未设置金额上限：无费用闸"');
      ok(rNone.includes('Token预算: 1,200,000 tokens'), '未设上限：Token 预算行仍完整');

      const rProj = render(2, 'project', true);
      ok(rProj.includes('费用上限: ¥2.00（项目级）'), '★项目级上限：如实标出来源与金额');
      ok(!rProj.includes('未设置金额上限') && !rProj.includes('费用闸不生效'), '★项目级已定价：既不谎称未设、也不误报不生效');

      const rTask = render(3.5, 'task', true);
      ok(rTask.includes('费用上限: ¥3.50（任务级）'), '★任务级上限：如实标出来源与金额');
      ok(!rTask.includes('未设置金额上限'), '★任务级已定价：不谎称未设');

      const rUnpriced = render(3.5, 'task', false);
      ok(rUnpriced.includes('费用上限: ¥3.50（任务级）') && rUnpriced.includes('费用闸不生效'),
        '★设了但模型未定价：金额照写，另如实说"费用闸不生效"（两条不具足路径分开说）');

      ok(rProj.includes('60%/75%') && rProj.includes('95%') && rProj.includes('98%'),
        '★档位说明为真源口径 60%/75%/95%/98%（X4 已订正，不可回退）');
      ok(!rProj.includes('70%时预警') && !rProj.includes('70% 时预警'), '★不再出现失实的"70% 预警"');
    }
  }

  console.log('S1 闸的成立条件与两条"不具足"路径如实分开说');
  {
    ok(/const costGateActive = maxCost > 0 && \(inputPricePer1k \+ outputPricePer1k\) > 0;/.test(exe),
      '闸成立条件 = ①有人许下(maxCost>0) ②模型已定价（两条件具足则法生）');
    ok(exe.includes('[费用闸未启用]'), '★未设上限走 [费用闸未启用]（本就没有闸，不谈"失效"）');
    ok(exe.includes('[费用闸未生效]'), '★设了但未定价走 [费用闸未生效]（沿用 zx_20260910_5 路径）');
    ok(/if \(costSrc === 'none'\) \{/.test(exe) && /else if \(!costGateActive\) \{/.test(exe),
      '★两条路径是**分开的**分支（不混为一句静默，也不合并成一句假话）');
    ok(/来源：\$\{costSrc === 'task' \? '任务级' : '项目级'\}/.test(exe), '告知消息如实标注上限来源');
  }

  console.log('S2 ARCHETYPE_BUDGETS 不再是最二真源（原型默认金额已删）');
  {
    const block = (arch.match(/export const ARCHETYPE_BUDGETS[\s\S]*?\n\};/) || [''])[0];
    ok(block.length > 0, 'ARCHETYPE_BUDGETS 定义仍在（token 侧原型默认预算保留）');
    ok(!/\bcost:/.test(block), '★原型预算块内已无 cost 键（凭空兜底的金额真源已删）');
    ok(/Record<TaskArchetype, \{ tokens: number \}>/.test(block), '★类型已收窄为 { tokens: number }（编译器层面杜绝再塞 cost）');
    ok(!/budget\.cost|ARCHETYPE_BUDGETS\.cost|\.cost\b\s*[:=]/.test(arch),
      '★task-archetype.ts 内再无「预算金额」类字段（modelStrategy 的 cost-optimal 属模型策略，另见下条守护）');
    ok(/modelStrategy: 'cost-optimal'/.test(arch), '模型策略 cost-optimal 未被误删（本轮只删预算金额，不碰模型策略）');
    ok(!/modeApplied\.budget\.cost/.test(exe), '★引擎侧已无 modeApplied.budget.cost 引用（三级坍缩链的末端已断）');
    ok(/budget: \{ tokens: Math\.round\(budget\.tokens \* 0\.5\) \}/.test(arch), '快速模式仅折 token，不再折金额');
  }

  console.log('S3 费用记账仍在（没有上限 ≠ 没有账）');
  {
    ok(/let totalCostUsed = 0;/.test(exe), '费用累计局部变量仍在');
    ok(/totalCostUsed = Number\(prevCtx\.cost_used\) \|\| 0;/.test(exe), '跨 resume 从 cost_used 恢复（单计数器，与 token 侧同口径）');
    ok(/totalCostUsed \+= stepCostCny;/.test(exe), '逐步累计仍在（+=');
    ok(/ctxJson\.cost_used = totalCostUsed;/.test(exe), 'cost_used 仍逐步回写');
    ok(/ctxJson\.cost_usage_ratio = costRatio;/.test(exe), 'cost_usage_ratio 仍逐步回写');
    ok(/const costRatio = costGateActive && maxCost > 0 \? \(cumCost \/ maxCost\) : 0;/.test(exe),
      '★边界三：无闸时 ratio 恒 0（不拿"无上限"当分母）');
    ok(/ctxJson\.cost_budget_src = costSrc;/.test(exe) && /taskCtx\.cost_budget_src = costSrc;/.test(exe),
      '★来源一并落库（任务级 + 步进回写两处），GUI 三分支才有判据可用');
  }

  console.log('S4 双闸取严骨架未被本轮改动破坏（反回退）');
  {
    ok(/const tokenBand = budgetBandOf\(ratio\);/.test(exe) && /const costBand = budgetBandOf\(costRatio\);/.test(exe),
      'Token 与费用各算各的 band（同一 budgetBandOf 真源）');
    ok(/const band = Math\.max\(tokenBand, costBand\);/.test(exe), '★取较严者（任一先到即触发）—— 不得回退为单闸');
    ok(/ratio >= 0\.98 \? 5 : ratio >= 0\.95 \? 4 : ratio >= 0\.75 \? 3 : ratio >= 0\.60 \? 2 : 1/.test(exe),
      '档位阈值 98/95/75/60 一字未动（不得为修 P0 放松阈值）');
    ok(/disabledTools\.add\(key\);/.test(exe) && /disableToolGracefully\(key,/.test(exe),
      '★真闸动作仍在（真禁工具，不是只发消息）');
    ok((exe.match(/disabledTools\.add\(/g) || []).length >= 3, '★多处真禁动作仍在（≥3）',
      String((exe.match(/disabledTools\.add\(/g) || []).length));
    ok(/bandSrc = costBand > tokenBand \? '费用' : costBand < tokenBand \? 'Token' : 'Token\/费用';/.test(exe),
      '触发源如实标注（防把费用触发说成 Token 触发）');
  }

  console.log('S5 <budget-context> 内不再有"无来源的上限"');
  {
    const m = exeRaw.match(/return `<budget-context>[\s\S]*?<\/budget-context>`;/);
    const src = m ? m[0] : '';
    ok(src.length > 0, '说明书块源码在位');
    ok(/costSrc === 'none' \? '' : ` \| 费用上限: ¥\$\{maxCost\.toFixed\(2\)\}（\$\{costSrc === 'task' \? '任务级' : '项目级'\}）`/.test(src),
      '★费用上限行是**按来源条件插值**的（无许诺者整段不出现）');
    ok(src.includes('未设置金额上限') && src.includes('费用闸不生效'), '三态说明在源码内齐备（真伪由 S0 渲染探针判）');
    ok(src.includes('60%/75%'), '档位说明在源码内为 60%/75%');
    ok(!src.includes('70%'), '★说明书块内已无 70%（X4 订正不可回退）');
  }

  console.log('S6 GUI 三页名实同步（前端如实区分"有/无上限"）');
  {
    ok(td.includes('cost_budget_src'), 'TaskDetail：读 cost_budget_src 作为判据');
    ok(/costSrc === 'none' \|\| \(costMax != null && costMax <= 0\)/.test(td), '★TaskDetail：无上限判据覆盖"来源 none"与"数值 ≤0"');
    ok(td.includes('未设置金额上限'), '★TaskDetail：如实提示本任务未设金额上限');
    ok(td.includes('costGateActive === false'), 'TaskDetail：已设但未定价的既有提示仍在');
    ok(td.includes('留空 = 不设金额闸'), 'TaskDetail：输入框占位如实说明留空语义');
    ok(pd.includes('留空 = 不设金额闸'), 'ProjectDetail：输入框占位如实说明留空语义');
    ok(pd.includes('费用上限「—」'), '★ProjectDetail：上限为空时如实说明"暂无金额闸"');
    ok(pp.includes('费用上限留空 = 不设金额闸'), '★Projects：新建项目处如实说明"不再自动兜底默认金额"');
  }

  console.log('S7 防反向漂移（旧口径仍在，本轮不得顺手改名/改文案）');
  {
    ok(td.includes('（¥ 人民币）'), 'TaskDetail 费用卡标题仍标 ¥ 人民币（C1 口径不可回退）');
    ok(td.includes('费用预算（¥ 人民币/任务）'), 'TaskDetail 预算编辑器标签未改名');
    ok(/¥\$\{ctxForm\.max_cost_usd_per_task\}/.test(td), 'TaskDetail 仍展示该值（名实：按 ¥ 存/用/展）');
    ok(pd.includes('费用上限(¥)/任务'), 'ProjectDetail 标签未改名');
    ok(pd.includes('¥{ctx.budget.max_cost_usd_per_task'), 'ProjectDetail 仍展示该值');
    ok(pp.includes('单任务费用上限¥(如3.6)'), 'Projects 既有占位未被误改');
  }

  console.log('S8 run_features.build 已刷新为本轮（派生一致性，非字面量）');
  {
    // 订正（M5 落地时）：原为字面量钉 `build: 'zx_20260911_5'` + 反向残留 `!/build: 'zx_20260911_4'/`
    // （每开新轮须手改，逐轮滚长）。改为**派生一致性**：真源＝agent-executor.ts 的那一处 build 值；
    // P1「恰好一处」**严格强于**原反向钉（陈旧第二值无论是什么都会被抓住），P6 亦核对产物同值。
    // 见 plans/improve/zx_20260912.md §M5 与 scripts/lib/rr-pins.ts。
    checkBuildPins(ok, { distDir: path.join(ROOT, 'apps/worker-ant-desktop/dist') });
  }

  console.log('S9 端到端产物证据（实践论：只验源码不算数，须在构建产物内实测）');
  {
    const distDir = path.join(ROOT, 'apps/worker-ant-desktop/dist');
    let files: string[] = [];
    try { files = fs.readdirSync(distDir).filter((f) => f.endsWith('.js')); } catch { /* 未构建 */ }
    const blob = files.map((f) => fs.readFileSync(path.join(distDir, f), 'utf-8')).join('\n');
    ok(files.length > 0, `dist 构建产物在位（${files.length} 个 .js）`, files.length ? '' : '(请先 tsup)');
    ok(blob.includes('resolveCostBudget'), '★产物内含来源解析真源 resolveCostBudget');
    ok(blob.includes('buildBudgetContextBlock'), '★产物内含可测说明书函数 buildBudgetContextBlock');
    ok(blob.includes('cost_budget_src'), '★产物内含 cost_budget_src（来源已随任务落库，非死字段）');
    ok(blob.includes('budgetBandOf'), '产物内含档位单一真源 budgetBandOf');
    ok(blob.includes('disabledTools') && blob.includes('bandSrc'), '产物内含真闸动作与触发源标注');
    ok(!/cost:\s*[\d.]/.test(blob), '★产物内 ARCHETYPE_BUDGETS 无原型默认金额字面量（proto cost 未进包）');
  }

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})();
