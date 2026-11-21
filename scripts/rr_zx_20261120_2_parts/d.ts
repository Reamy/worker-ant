/**
 * zx_20261120_2 D 组「度」——续额按基础上限线性发放。
 *
 * 归属：M4。实施者只改本文件与 M4 的生产代码，不碰其它分组。
 *
 * 纪律：直引生产真实现（`step-budget.ts`），数值由函数自己算出，
 * 不在断言里抄生产公式；两侧标本（线性 / 上限）。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { RrHarness } from '../rr_zx_20261120_2.js';
import { grantStepBudgetOnCapHit, stepCapContinuationOf, resolveMaxSteps } from '../../apps/worker-ant-desktop/src/main/core/step-budget.js';

export function runD(h: RrHarness): void {
  // D1：基础 74、连续两次撞顶 ⇒ bonus=148（不是 222/225）
  const ctx: Record<string, unknown> = {};
  const g1 = grantStepBudgetOnCapHit(ctx, 74);
  h.eq(g1.grantedSteps, 74, 'D1 第一次续额 = 基础上限 74');
  h.eq(g1.bonus, 74, 'D1 累计 74');
  const g2 = grantStepBudgetOnCapHit(ctx, 74);
  h.eq(g2.grantedSteps, 74, 'D1 第二次续额仍按基础 74（非含续额的 148）');
  h.eq(g2.bonus, 148, 'D1 两次累计 148（线性）');
  h.eq(g2.grants, 2, 'D1 次数 2');

  // D2：第三次仍发（bonus=222、grants=3）；第四次才 granted=false
  const g3 = grantStepBudgetOnCapHit(ctx, 74);
  h.ok(g3.granted === true, 'D2 第三次仍发');
  h.eq(g3.bonus, 222, 'D2 三次累计 222');
  h.eq(g3.grants, 3, 'D2 次数到 3');
  const g4 = grantStepBudgetOnCapHit(ctx, 74);
  h.ok(g4.granted === false, 'D2 第四次不再发（上限 3）');
  h.eq(g4.bonus, 222, 'D2 超限后 bonus 不变');

  // D3：续额回读与发放一致
  {
    const c: Record<string, unknown> = { step_cap_hit: { count: 3, resume_bonus: 74 } };
    const cont = stepCapContinuationOf(c);
    h.eq(cont?.grantedSteps, 74, 'D3 grantedSteps 回读 74');
    h.eq(cont?.grants, 3, 'D3 grants 回读 3');
    h.eq(cont?.limit, 3, 'D3 limit 回读 3');
    h.ok(cont?.granted === true, 'D3 granted 回读 true');
  }

  // D4：执行体记账带基础上限（静态钉，防只改纯函数没接线）
  {
    const ae = fs.readFileSync(path.join(h.root, h.A, 'src/main/core/agent-executor.ts'), 'utf-8');
    const sb = fs.readFileSync(path.join(h.root, h.A, 'src/main/core/step-budget.ts'), 'utf-8');
    h.ok(/\bbase_max_steps\b/.test(sb), 'D4 续额账写入 base_max_steps');
    h.ok(/grantStepBudgetOnCapHit\(ctxJson, baseForGrant\)/.test(sb), 'D4 续额按基础值发放');
    h.ok(/recordStepCapHit\(ctxJson, \{/.test(ae), 'D4 执行体调用同一落账口');
  }

  // D5：边界与既有公式不倒退
  {
    h.ok(grantStepBudgetOnCapHit({}, 0).granted === false, 'D5 基础 0 不发');
    h.ok(grantStepBudgetOnCapHit(null, 74).granted === false, 'D5 非法 ctx 不发');
    h.eq(resolveMaxSteps(40, 1.5, 49, 148), 222, 'D5 上限公式仍是 base + bonus（148 线性叠加）');
  }
}
