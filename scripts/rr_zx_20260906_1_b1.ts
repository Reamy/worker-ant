/**
 * zx_20260906_1 批1 受控复跑（node:sqlite/纯函数 + 源码静态防回归；绝不触碰开发库；用法同 rr_zx_20260906_b2.ts，经桌面 node_modules/.bin/tsx 运行）。
 * S1 1a 旁路 token 记账纯函数：estTextTokens 字÷4 min1；usageTokensOf 优先真实 usage、缺省回退估算。
 * S2 1b finalize 校验调序（静态防回归）：finalize_task 工具内"验收(检查5')"文本必须位于"内容充分性门禁"之后——内容不充分先拦、不再白耗一次验收 LLM。
 * S3 1a/1c 成本如实透出（静态防回归）：agent-executor 收口有 sideAtFirstPersist+reconcile 并账；TaskDetail 成本区渲染 sideTokens 与 bg_review_usage。
 * （旁路入账/验收消费的真实数值需真实 agent run 复核——1a/1b/1c 为集成语义，见方案 §九）
 */
import fs from 'node:fs';
import path from 'node:path';
import { usageTokensOf, estTextTokens } from '../apps/worker-ant-desktop/src/main/core/agent-executor.js';
import { engineSrc } from './lib/rr-engine-src.js';

let pass = 0; let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

console.log('S1 1a 旁路 token 记账纯函数');
ok(estTextTokens('abcd') === 1, 'estTextTokens 字÷4 估算', '4字→1');
ok(estTextTokens('') === 1, 'estTextTokens 空串最小1');
ok(estTextTokens('a'.repeat(10), 'b'.repeat(2)) === 3, 'estTextTokens 多段求和', '(10+2)/4→3');
ok(usageTokensOf({ usage: { promptTokens: 100, completionTokens: 50 }, text: '' }) === 150, 'usageTokensOf 优先真实 usage', '100+50=150');
ok(usageTokensOf({ usage: { totalTokens: 777 } }) === 777, 'usageTokensOf totalTokens 优先', '777');
ok(usageTokensOf({ text: 'x'.repeat(400) }, 'p'.repeat(400)) === 200, 'usageTokensOf 无 usage 回退估算', '(400+400)/4=200');

console.log('S2 1b finalize 校验调序（静态防回归）');
const exe = engineSrc();
// zx_20261003 M8 就地改钉：`finalize_task` 的执行体已由 `core/tools/control.ts` 机械搬迁至
//   `core/tools/control-finalize.ts`（导出 `runFinalizeTask`）。并集里 `finalize_task: {` 那个字面块
//   仍留在 `control.ts`（schema/description），而"内容门 → 验收"的次序位于搬迁后的执行体 ⇒
//   若仍从 `finalize_task: {` 起锚，块内两锚皆缺席、断言报成"验收不在内容门之后"（读起来像真回归，
//   实为扫描面没跟着实现走）。扫描面指到**执行体现在所在**——判据/次序要求一字未改。
const finSrc = fs.readFileSync(path.join(__dirname, '../apps/worker-ant-desktop/src/main/core/tools/control-finalize.ts'), 'utf-8');
const gateIdx = finSrc.indexOf('finalize 内容充分性门禁');
const acceptIdx = finSrc.indexOf('检查5\' 验收标准核对');
ok(gateIdx > -1 && acceptIdx > -1, 'finalize 工具内（control-finalize.ts，M8 就地改钉）同时存在 内容门 与 验收');
ok(acceptIdx > gateIdx, '验收(检查5\') 位于 内容充分性门 之后 —— 内容不充分先拦、不再白耗验收 LLM（control-finalize.ts，M8 就地改钉）');
ok(finSrc.indexOf('验收消费刚写入并落库的 output_validations') > -1, '验收消费已落库的 output_validations(注释锚·control-finalize.ts，M8 就地改钉)');

console.log('S3 1a/1c 成本如实（并账 + 透出 静态防回归）');
ok(exe.includes('sideAtFirstPersist'), '收口首次并账 sideAtFirstPersist 存在');
ok(exe.includes('sideNow > sideAtFirstPersist'), '收口内容门后 reconcile 增量并账存在');
ok(exe.includes('ce.sideTokens = sideAtFirstPersist'), 'cost_estimate.sideTokens 落账存在');
const tdp = fs.readFileSync(path.join(__dirname, '../apps/worker-ant-desktop/renderer/src/pages/TaskDetailPage.tsx'), 'utf-8');
ok(tdp.includes('sideTokensCe') && tdp.includes('bg_review_usage'), 'TaskDetail 渲染 sideTokens(1a) 与 bg_review_usage(1c)');
ok(tdp.includes('· 旁路~') && tdp.includes('· 复盘~'), 'TaskDetail 展示 旁路~/复盘~ 徽标');

console.log(`结果: ${pass} 通过, ${fail} 失败`);
if (fail > 0) process.exit(1);
