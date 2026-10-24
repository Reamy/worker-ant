/**
 * zx_20261021_1 受控复跑 —— 「名」：项目详情里的机器口音，换成人话。
 *
 * 病根：`ProjectDetailPage` 的「自适应策略 / 多维度健康视图」把**内部键**直接打给用户——
 *   模型档 `capability-best`、健康指标 `costEfficiency`/`deadlineRisk`、调参历史里的状态码
 *   `completed`/`failed` 与裸浮点 `0.4499999999999999`（真库实测）。
 * 治法：词表**一处真源**（`renderer/src/lib/project-insight.ts`），页面只取词；
 *   不认识的值如实回显原值——"不认识"不等于"可以编一个中文名"。
 *
 * ── 纪律 ────────────────────────────────────────────────────────────────
 *   G-1 用生产函数：词表与格式化函数静态导入生产导出（被删/改名即编译期失败）。
 *   G-2 两侧标本：认识的值转中文 + 不认识的值原样保留（两个方向都钉）。
 *   G-5 判"接线在册"读去注释后的代码；注释不能替实现签字。
 *   G-6 无轮次字面量：S1–S3 由 `path.basename(__filename)` 派生。
 *   ★ 覆盖面的键域**由生产者派生**（`healthViews` 返回对象解析 + `MODEL_TIER_LADDER` 导入），
 *     不另抄一份"我以为的键表"——那正是「断言名冒充覆盖面」的病形。
 */
import fs from 'node:fs';
import path from 'node:path';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';
import { MODEL_TIER_LADDER } from '../apps/worker-ant-desktop/src/main/core/feedback-engine.js';
import {
  MODEL_STRATEGY_LABEL,
  HEALTH_VIEW_LABEL,
  HEALTH_METRIC_LABEL,
  formatStrategyAdjustment,
  formatStrategyAdjustments,
  formatStrategyNumber,
} from '../apps/worker-ant-desktop/renderer/src/lib/project-insight.js';
import { TASK_STATUS_LABEL, statusText } from '../apps/worker-ant-desktop/renderer/src/lib/status-view.js';

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
function eq(actual: unknown, expected: unknown, label: string, detail?: string): void {
  ok(JSON.stringify(actual) === JSON.stringify(expected), label, detail ?? `实测 ${JSON.stringify(actual)}`);
}

const ROOT = path.join(__dirname, '..');
const A = 'apps/worker-ant-desktop';
const rd = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf-8');
const CODE = (f: string) => stripKeepingLines(rd(f)).join('\n');
const SELF_ROUND = (path.basename(__filename).match(/^rr_(zx_\d{8}(?:_\d+)?)\.ts$/) || [])[1] || '';

/** 从 `start` 后第一个 `{` 起做配对括号切片（值里没有花括号，故只需数 `{}`）。 */
function braceBlock(src: string, start: number): string {
  const i = src.indexOf('{', start);
  if (i < 0) return '';
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(i, j + 1); }
  }
  return '';
}

/** 对象字面量的**顶层**条目（逗号按括号深度切，避免 `toScore(a, b)` 里的逗号切坏）。 */
function topLevelEntries(block: string): string[] {
  const inner = block.slice(1, -1);
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of inner) {
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

/** 一条目 → 键名（支持简写属性 `velocity`）。 */
function entryKey(seg: string): string {
  let depth = 0;
  for (let i = 0; i < seg.length; i++) {
    const ch = seg[i]!;
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    else if (ch === ':' && depth === 0) return seg.slice(0, i).trim();
  }
  return seg.trim();
}

const hasCJK = (s: string) => /[一-龥]/.test(s);

console.log('S1 轮次自指（由载体派生，不写字面量）');
{
  ok(/^zx_\d{8}(_\d+)?$/.test(SELF_ROUND), '脚本文件名可派生出合法轮次标识', SELF_ROUND || '(未匹配)');
  ok(SELF_ROUND !== '' && fs.existsSync(path.join(ROOT, `plans/improve/${SELF_ROUND}.md`)), '本轮方案文件在场');
  ok(SELF_ROUND !== '' && fs.existsSync(path.join(ROOT, `scripts/rr_${SELF_ROUND}.ts`)), '本套件在册');
  const selfPins = [...CODE(`scripts/${path.basename(__filename)}`).matchAll(/(?<![A-Za-z0-9_])(?:build:\s*|ROUND\s*=\s*|includes\()'(zx_[0-9_]+)'/g)];
  ok(selfPins.length === 0, '本文件零 build 轮次字面量（G-6）', selfPins.map((m) => m[1]).join(',') || '0 处');
}

console.log('S2 模型档词表：覆盖面由 MODEL_TIER_LADDER 派生');
{
  for (const tier of MODEL_TIER_LADDER) {
    const label = MODEL_STRATEGY_LABEL[tier];
    ok(!!label && hasCJK(label), `模型档 ${tier} 有中文名`, label || '(缺)');
  }
  ok(!!MODEL_STRATEGY_LABEL['latency-optimal'] && hasCJK(MODEL_STRATEGY_LABEL['latency-optimal']!),
    'ANS 侧 latency-optimal 亦有中文名（真库虽只出现过三档，值域仍须认全）');
  eq(statusText(MODEL_STRATEGY_LABEL, 'capability-best'), '能力优先', '真库实测值 capability-best → 能力优先');
  eq(statusText(MODEL_STRATEGY_LABEL, 'some-future-strategy'), 'some-future-strategy',
    '不认识的值如实回显原值（G-2 反面标本，不编中文名）');
}

console.log('S3 健康视图词表：键域由 project.ipc.ts 的生产者对象派生');
{
  const pipc = CODE(`${A}/src/main/ipc/project.ipc.ts`);
  const at = pipc.indexOf("ipcMain.handle('project:healthViews'");
  ok(at >= 0, '生产者 project:healthViews 在册');
  const returnAt = pipc.indexOf('return { data: {', at);
  const outer = braceBlock(pipc, returnAt + 'return '.length); // 从 `return` 后的 `{` 起
  ok(outer.length > 0, '生产者返回对象可解析（花括号配对）');
  // return { data: { investor…, developer…, manager… } } —— 先取 `data` 那一格，再读三视角
  const dataSeg = topLevelEntries(outer).find((s) => entryKey(s) === 'data') || '';
  const views = topLevelEntries(braceBlock(dataSeg, 0));
  const viewKeys = views.map(entryKey);
  eq(viewKeys, ['investor', 'developer', 'manager'], '三视角键与页面消费的取值域一致', viewKeys.join(','));
  for (const view of viewKeys) {
    const label = HEALTH_VIEW_LABEL[view];
    ok(!!label && hasCJK(label), `视角 ${view} 有中文名`, label || '(缺)');
    const start = views.findIndex((s) => entryKey(s) === view);
    const block = braceBlock(views[start] || '', 0);
    const keys = topLevelEntries(block).map(entryKey);
    // 页面只把 score / parkedReason 排除在指标行之外（score 单独大字、parkedReason 单独一句）
    const shown = keys.filter((k) => k !== 'score' && k !== 'parkedReason');
    ok(shown.length > 0, `视角 ${view} 解析出指标键`, shown.join(','));
    for (const k of shown) {
      const label2 = HEALTH_METRIC_LABEL[k];
      ok(!!label2 && hasCJK(label2), `指标 ${view}.${k} 有中文名`, label2 || '(缺)');
    }
  }
}

console.log('S4 页面接线（读去注释后的代码）');
{
  const pd = CODE(`${A}/renderer/src/pages/ProjectDetailPage.tsx`);
  ok(/import \{[^}]*MODEL_STRATEGY_LABEL[^}]*\} from '\.\.\/lib\/project-insight'/.test(pd), '页面引模型档词表真源');
  ok(/import \{[^}]*HEALTH_METRIC_LABEL[^}]*\}/.test(pd) && pd.includes("from '../lib/project-insight'"), '页面引健康指标词表真源');
  ok(pd.includes('statusText(MODEL_STRATEGY_LABEL, strategyInfo.modelStrategy)'), '模型策略经词表译文上屏');
  ok(pd.includes('formatStrategyNumber(strategyInfo.temperature)'), '温度经两位小数格式化');
  ok(pd.includes('statusText(TASK_STATUS_LABEL, a.reason)'), '调参历史 reason 经任务状态词表译名（不再直出 completed/failed）');
  ok(pd.includes('formatStrategyAdjustments(a.adjustments)'), '调参历史正文经展示形格式化（不再 JSON.stringify 出方括号/引号）');
  ok(!pd.includes('JSON.stringify(a.adjustments)'), '反向：旧直出写法已消失');
  ok(pd.includes('statusText(HEALTH_METRIC_LABEL, k)'), '健康指标名经词表译文上屏');
  ok(!/>\{k\}<\/span>/.test(pd), '反向：指标行不再渲染裸键 {k}');
  ok(pd.includes("statusText(HEALTH_VIEW_LABEL, view)"), '健康视角名经词表译文上屏');
  ok(!pd.includes("const labels: Record<string, string> = { investor:"), '反向：页内第二份视角词表已删除');
  ok(pd.includes("k !== 'score' && k !== 'parkedReason'"), '指标行过滤面未变（score/parkedReason 各有专属呈现）');
}

console.log('S5 格式化函数行为（正反标本）');
{
  eq(formatStrategyAdjustments(['model: capability-best→balanced（连续 3 次高质量完成，回落）']),
    '模型策略：能力优先→均衡（连续 3 次高质量完成，回落）', '档位值与前缀同批译名');
  eq(formatStrategyAdjustment('temperature: 0.24999999999999994→0.15（无产出物，提高精确度）'),
    '温度：0.25→0.15（无产出物，提高精确度）', '连乘浮点收敛两位（只改显示，不改语义）');
  eq(formatStrategyAdjustment('maxSteps: 30→30（步骤使用率>80%）'), '最大步数：30→30（步骤使用率>80%）', 'maxSteps 前缀译名');
  eq(formatStrategyAdjustment('策略熔断生效中（x）：本该升档（任务失败），暂不升：model 保持 capability-best'),
    '策略熔断生效中（x）：本该升档（任务失败），暂不升：模型策略保持 能力优先', '熔断从句里的档位亦译名');
  eq(formatStrategyAdjustment('foo: bar'), 'foo: bar', '不认识的字段原样保留（G-2 反面标本）');
  eq(formatStrategyAdjustments(['模型策略：能力优先→均衡', '温度：0.3→0.35']), '模型策略：能力优先→均衡；温度：0.3→0.35',
    '数组逐条以「；」连接');
  eq(formatStrategyNumber(0.4499999999999999), '0.45', '温度 0.4499999999999999 → 0.45');
  eq(formatStrategyNumber(null), '—', '空温度显示 —（不伪造成 0）');
  eq(statusText(TASK_STATUS_LABEL, 'completed'), '已完成', 'reason completed → 已完成');
  eq(statusText(TASK_STATUS_LABEL, 'failed'), '失败', 'reason failed → 失败');
}

console.log('S6 renderer 产物含中文词（真值取自构建产物，非源码自证）');
{
  const assetsDir = path.join(ROOT, A, 'renderer/dist/assets');
  const chunks = fs.existsSync(assetsDir)
    ? fs.readdirSync(assetsDir).filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(path.join(assetsDir, f), 'utf-8')).join('\n')
    : '';
  ok(chunks.length > 0, 'renderer 产物在场（本判据须 renderer 先 build）', chunks ? '' : 'renderer/dist/assets 不存在');
  for (const word of ['能力优先', '成本优先', '近7日完成率', '模型策略：']) {
    ok(chunks.includes(word), `产物含中文词「${word}」`);
  }
}

console.log('S7 build 标识钉子（P1–P6）');
{
  let pinPass = 0;
  let pinFail = 0;
  checkBuildPins((cond, label, detail) => {
    ok(cond, label, detail);
    if (cond) pinPass += 1; else pinFail += 1;
  }, { distDir: path.join(ROOT, A, 'dist') });
  eq(pinFail, 0, 'checkBuildPins P1–P6 全绿（0 红）', `绿 ${pinPass} / 红 ${pinFail}`);
  ok(pinPass >= 6, '至少六条判据真跑过（"没考"不算"考过"）', `实测 ${pinPass} 条`);
}

console.log(`\n${fail === 0 ? '✅' : '❌'} rr_${SELF_ROUND}: ${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
