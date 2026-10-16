/**
 * zx_20260906_2 批2 受控复跑（纯函数行为 + 源码静态防回归；绝不触碰开发库；经桌面 node_modules/.bin/tsx 运行）。
 * S1 2a 运行时：buildAcceptanceCheckPayload 逐条 {criterion,passed,reason} → acceptance_check（通过项保留、拒收项带 reason、trim/缺省兜底）。
 * S2 2a 静态：checkAcceptanceCriteria「通过也落库、拒收亦落库、拒收错误串保留、门禁语义不变」——
 *           zx_20260910_3 M1 后这些语义收敛到 acceptance-check.ts（四出口归一），断言随之改写指向新单点；
 *           旧断言编码的是"只有真通过才落库"的旧结构（正是 G1 病根），故不再复述旧形状。
 *           ⚠ 含成因的全覆盖断言在 scripts/rr_zx_20260910_3_b1.ts（S1/S1b/S4），本文件只守旧语义不回归。
 * S3 2b 静态：TaskDetail 含 acceptanceCheck 派生 + 「验收标准核对」面板（passed/failed 逐条渲染）。
 * （真实验收 LLM 逐条核对为集成语义，随真实 agent run/§十 E2 复核。）
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildAcceptanceCheckPayload } from '../apps/worker-ant-desktop/src/main/core/agent-executor.js';

let pass = 0; let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

const ROOT = path.join(__dirname, '..');
const exe = fs.readFileSync(path.join(ROOT, 'apps/worker-ant-desktop/src/main/core/agent-executor.ts'), 'utf-8');
const tdp = fs.readFileSync(path.join(ROOT, 'apps/worker-ant-desktop/renderer/src/pages/TaskDetailPage.tsx'), 'utf-8');

console.log('S1 2a buildAcceptanceCheckPayload 行为');
const allPass = buildAcceptanceCheckPayload([
  { criterion: 'A可用', passed: true, reason: 'ok' },
  { criterion: 'B已测', passed: true },
  { criterion: 'C有文档', passed: false, reason: '缺.md' },
  { criterion: 'D性能达', passed: false },
]);
ok(allPass.criteria_total === 4, 'criteria_total = 逐条总数(4)');
ok(allPass.passed_total === 2, 'passed_total = 通过数(2)');
ok(allPass.failed.length === 2, 'failed 含拒收项(2)');
ok(allPass.passed.includes('A可用') && allPass.passed.includes('B已测'), '通过项 criterion 文本保留(可复盘)');
ok(allPass.passed_total === allPass.passed.length, 'passed_total 与 passed 数组一致');
const cFail = allPass.failed.find((f) => f.criterion === 'C有文档');
ok(cFail?.reason === '缺.md', '拒收项 reason 保留');
ok(allPass.failed.some((f) => f.criterion === 'D性能达' && f.reason === '未说明'), 'reason 缺省兜底「未说明」');
ok(allPass.checked_at && !Number.isNaN(new Date(allPass.checked_at).getTime()), 'checked_at 时间戳有效');
const empty = buildAcceptanceCheckPayload([]);
ok(empty.criteria_total === 0 && empty.passed_total === 0 && empty.failed.length === 0, '空核对 → 空载荷');
const trim = buildAcceptanceCheckPayload([{ criterion: '  带空格  ', passed: true }, { criterion: '  ', passed: false }]);
ok(trim.passed[0] === '带空格', 'criterion trim');
ok(trim.failed.length === 1 && trim.failed[0].criterion === '未命名' && trim.failed[0].reason === '未说明', '全空白 criterion 拒收项 → 兜底「未命名」+「未说明」(不丢拒收计数)');

console.log('S2 2a 静态(旧语义不回归 · 单点已收敛到 acceptance-check.ts)');
const acc = fs.readFileSync(path.join(ROOT, 'apps/worker-ant-desktop/src/main/core/acceptance-check.ts'), 'utf-8');
const fnStart = exe.indexOf('async function checkAcceptanceCriteria');
const fnEnd = exe.indexOf('async function checkGoalDeviation', fnStart);
const fnBody = exe.slice(fnStart, fnEnd > fnStart ? fnEnd : undefined);
ok(fnBody.includes('recordAcceptanceOutcome(db, taskId, decided)'), '验收证据经 recordAcceptanceOutcome 落库(四出口共用一笔)');
ok(/^\s{2}const payload = recordAcceptanceOutcome\(db, taskId, decided\);/m.test(fnBody), '落库调用无条件(不再只有"通过"那一支落库 ⇒ 台账恒 0 的病根已除)');
ok(acc.includes('const failed = checks.filter((c) => c.passed === false);'), '先算 failed 再定夺(通过/拒收同一处判定)');
ok(acc.includes('error: `验收标准未达成（${failed.length} 项），请补齐后再 finalize：'), '拒收错误串保留(拒收亦落库，错误串原样)');
ok(fnBody.includes('const block = decided.outcome.ran && !decided.outcome.passed ? decided.outcome.block : null;'), '门禁语义不变：只有真拒收才返回拦截串(未跑/通过一律不拦)');
ok(acc.includes("UPDATE wa_tasks SET context_json = ? WHERE id = ?"), '落库为 UPDATE context_json(零 schema 变更)');
ok(acc.includes('export function buildAcceptanceCheckPayload'), 'payload 纯函数已导出(可测，单点定义在 acceptance-check.ts)');
ok(exe.includes("export { buildAcceptanceCheckPayload } from './acceptance-check.js';"), 'agent-executor 保留旧导出(本文件顶部 import 不裂)');

console.log('S3 2b 静态(TaskDetail 面板)');
ok(tdp.includes('acceptanceCheck = ctx?.acceptance_check'), 'ctx.acceptance_check 派生存在');
ok(tdp.includes('验收标准核对'), '面板标题「验收标准核对」存在');
ok(tdp.includes('(acceptanceCheck.passed ?? [])') && tdp.includes('(acceptanceCheck.failed ?? [])'), 'passed/failed 逐条渲染');
ok(tdp.includes('已达成') && tdp.includes('原因：'), '通过/拒收均有可见文案');
ok(tdp.includes('Target'), '面板使用 Target 图标(已 import)');

console.log(`结果: ${pass} 通过, ${fail} 失败`);
if (fail > 0) process.exit(1);
