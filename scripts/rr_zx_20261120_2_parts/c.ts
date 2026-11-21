/**
 * zx_20261120_2 C 组「衡」——探索配额跨恢复一本账。
 *
 * 归属：M3。实施者只改本文件与 M3 的生产代码，不碰其它分组。
 *
 * 纪律：直引生产真实现（`quota-ledger.ts` / `tool-registry.ts`），
 * 两侧标本同试；单键写入必须保住 `context_json` 的兄弟键。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { RrHarness } from '../rr_zx_20261120_2.js';
import { readExploreLedger, writeExploreLedger } from '../../apps/worker-ant-desktop/src/main/core/quota-ledger.js';
import { ExploreQuotaLedger, SHELL_EXPLORE_QUOTA_KEY } from '../../apps/worker-ant-desktop/src/main/core/tool-registry.js';

export function runC(h: RrHarness): void {
  // C1：第一次 run 记 12 次，第二次 run hydrate 后从 12 起算（不是 0）
  {
    const first = new ExploreQuotaLedger();
    for (let i = 0; i < 12; i++) first.add(SHELL_EXPLORE_QUOTA_KEY);
    const snap = first.snapshot();
    h.eq(snap.counts[SHELL_EXPLORE_QUOTA_KEY], 12, 'C1 第一轮记账 12 次');
    const ctx: Record<string, unknown> = {};
    writeExploreLedger(ctx, snap);
    const second = new ExploreQuotaLedger();
    second.hydrate(readExploreLedger(ctx));
    h.eq(second.count(SHELL_EXPLORE_QUOTA_KEY), 12, 'C1 第二轮从 12 起算（跨恢复续算）');
    second.add(SHELL_EXPLORE_QUOTA_KEY);
    h.eq(second.count(SHELL_EXPLORE_QUOTA_KEY), 13, 'C1 第二轮再记一次 → 13');
  }

  // C2：软告警跨 run 只响一次（第二轮 hydrate 后不再响）
  {
    const first = new ExploreQuotaLedger();
    const limit = { soft: 2, hard: 5, softMsg: 'soft', hardMsg: 'hard' };
    first.add(SHELL_EXPLORE_QUOTA_KEY);
    const g1 = first.add(SHELL_EXPLORE_QUOTA_KEY);
    h.eq(g1, 2, 'C2 第一轮到达软线 2');
    h.eq(first.gate(SHELL_EXPLORE_QUOTA_KEY, limit).softMsg, 'soft', 'C2 第一轮软告警响一次');
    const second = new ExploreQuotaLedger();
    second.hydrate(first.snapshot());
    const g2 = second.gate(SHELL_EXPLORE_QUOTA_KEY, limit);
    h.ok(g2.softMsg === undefined, 'C2 第二轮不再重复软告警');
  }

  // C3：两次 run 合计到硬线后，下一次被拒（同一本账）
  {
    const first = new ExploreQuotaLedger();
    for (let i = 0; i < 19; i++) first.add(SHELL_EXPLORE_QUOTA_KEY);
    const ctx: Record<string, unknown> = {};
    writeExploreLedger(ctx, first.snapshot());
    const second = new ExploreQuotaLedger();
    second.hydrate(readExploreLedger(ctx));
    second.add(SHELL_EXPLORE_QUOTA_KEY);
    const limit = { soft: 12, hard: 20, softMsg: 'soft', hardMsg: 'hard' };
    h.eq(second.count(SHELL_EXPLORE_QUOTA_KEY), 20, 'C3 跨 run 合计到 20');
    h.ok(second.gate(SHELL_EXPLORE_QUOTA_KEY, limit).hard === true, 'C3 第 21 次被硬拒');
  }

  // C4：没有 shell_explore 的老任务从 0 起（不猜）
  {
    const empty = readExploreLedger({});
    h.eq(empty.counts, {}, 'C4 无账 → counts 空');
    h.eq(new ExploreQuotaLedger().count(SHELL_EXPLORE_QUOTA_KEY), 0, 'C4 新任务从 0 起');
    h.eq(readExploreLedger('{"attachments":[]}').counts, {}, 'C4 坏形态/无关键 → 空账');
  }

  // C5：单键写入不抹兄弟键（附件/目标/方案仍在）
  {
    const ctx: Record<string, unknown> = {
      attachments: ['a.png'],
      task_goal: { goal: 'g' },
      scheme_ref: 's1',
    };
    writeExploreLedger(ctx, { counts: { [SHELL_EXPLORE_QUOTA_KEY]: 3 }, softWarned: [] });
    h.eq(ctx.attachments, ['a.png'], 'C5 兄弟键 attachments 仍在');
    h.eq(ctx.task_goal, { goal: 'g' }, 'C5 兄弟键 task_goal 仍在');
    h.eq(ctx.scheme_ref, 's1', 'C5 兄弟键 scheme_ref 仍在');
    h.eq(readExploreLedger(ctx).counts[SHELL_EXPLORE_QUOTA_KEY], 3, 'C5 shell_explore 可回读');
  }

  // C6：执行体真的接上了（纯模块绿 ≠ 接线在册）——恢复 hydrate / 逐步 json_set / 收口写回
  {
    const src = fs.readFileSync(path.join(h.root, h.A, 'src/main/core/agent-executor.ts'), 'utf-8');
    const ql = fs.readFileSync(path.join(h.root, h.A, 'src/main/core/quota-ledger.ts'), 'utf-8');
    h.ok(/hydrateExploreLedger\(db, taskId, quotaLedger\)/.test(src), 'C6 执行体恢复时 hydrate');
    h.ok(/createExploreLedgerPersistingStepHandler\(/.test(src)
      && /\$\.shell_explore/.test(ql) && /json_set\(/.test(ql), 'C6 逐步落库用 json_set 写 shell_explore');
    h.ok(/writeExploreLedger\(ctxJson, quotaLedger\.snapshot\(\)\)/.test(src), 'C6 收口/撞顶按同形状写回');
  }
}
