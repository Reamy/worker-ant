/**
 * zx_20261120_2 A 组「明」——暂停横幅与自动续跑一致。
 *
 * 归属：M1。实施者只改本文件与 M1 的生产代码，不碰其它分组。
 *
 * 断言口径（承方案 §3 M1 与 CLAUDE.md 纪律）：
 *   · 直引生产函数（被删/改名即编译期失败），不手抄判据；
 *   · 两侧标本同试：`due=true` 与三种 `due=false` 各有其位；
 *   · `due=false` 的旧文案按**逐字节相等**钉死（两只标本），防"顺手改了旧文案"；
 *   · 续额次数上限由 `STEP_CAP_GRANT_LIMIT` 派生，不写"只为下一轮"的字面量。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { RrHarness } from '../rr_zx_20261120_2.js';
import { autoResumeViewOf } from '../../apps/worker-ant-desktop/src/main/core/auto-resume-view.js';
import { voidStepCapAutoResume } from '../../apps/worker-ant-desktop/src/main/core/pause-settlement.js';
import {
  PAUSE_REASON_ACCEPTANCE_FAILED,
  PAUSE_REASON_QUALITY_BELOW_BAR,
  PAUSE_REASON_USER_INTERRUPT,
} from '../../apps/worker-ant-desktop/src/main/core/pause-reason.js';
import { STEP_CAP_GRANT_LIMIT } from '../../apps/worker-ant-desktop/src/main/core/step-budget.js';
import { pausedBannerHeadline, pausedBannerHint } from '../../apps/worker-ant-desktop/renderer/src/lib/pause-banner.js';

/** 撞顶暂停的标准标本：质量分未达交付标准 + 一笔已发续额 + 未接管。 */
function stepCapCtx(): Record<string, unknown> {
  return {
    pause_reason: PAUSE_REASON_QUALITY_BELOW_BAR,
    step_cap_grants: 1,
    step_budget_bonus: 74,
    step_cap_hit: { resume_bonus: 74, count: 1 },
  };
}

export function runA(h: RrHarness): void {
  // ── A1 自动续跑投影 ─────────────────────────────────────────────────────
  {
    const ctx = stepCapCtx();
    // 字符串与对象两种入参都要能解析（IPC 里 ctx 是 JSON 字符串，测试/内层调用是对象）。
    const fromString = autoResumeViewOf(JSON.stringify(ctx));
    const fromObject = autoResumeViewOf(ctx);
    h.eq(fromString.due, true, 'A1 撞顶暂停标本：due=true');
    h.eq(fromString.grants, 1, 'A1 已用续额次数');
    h.eq(fromString.limit, STEP_CAP_GRANT_LIMIT, 'A1 续额次数上限（由 STEP_CAP_GRANT_LIMIT 派生）');
    h.eq(fromString.resumeBonus, 74, 'A1 本次将获续额步数');
    h.ok(fromString.reason.trim().length > 0, 'A1 人话原因非空', fromString.reason);
    h.eq(fromObject, fromString, 'A1 JSON 字符串与对象入参同投影');
    // 坏 JSON 按空对象处理：due=false 且原因非空（不抛、不编 due=true）。
    const broken = autoResumeViewOf('{not json');
    h.eq(broken.due, false, 'A1 坏 JSON：due=false');
    h.ok(broken.reason.trim().length > 0, 'A1 坏 JSON：原因非空', broken.reason);
  }

  // ── A2 非撞顶停因不自动续跑 ─────────────────────────────────────────────
  {
    const specimens: Array<[string, Record<string, unknown>]> = [
      ['用户中止', { pause_reason: PAUSE_REASON_USER_INTERRUPT, step_cap_grants: 1, step_cap_hit: { resume_bonus: 74, count: 1 } }],
      ['未撞顶', { pause_reason: PAUSE_REASON_QUALITY_BELOW_BAR }],
      ['续额超限', {
        pause_reason: PAUSE_REASON_QUALITY_BELOW_BAR,
        step_cap_grants: STEP_CAP_GRANT_LIMIT + 1,
        step_cap_hit: { resume_bonus: 74, count: STEP_CAP_GRANT_LIMIT + 1 },
      }],
    ];
    for (const [name, ctx] of specimens) {
      const v = autoResumeViewOf(ctx);
      h.eq(v.due, false, `A2 ${name}：不自动续跑`);
      h.ok(v.reason.trim().length > 0, `A2 ${name}：原因非空`, v.reason);
    }
  }

  // ── A3 横幅两态 ─────────────────────────────────────────────────────────
  {
    const due = autoResumeViewOf(stepCapCtx());
    const head = pausedBannerHeadline({ reason: PAUSE_REASON_QUALITY_BELOW_BAR, reasonLabel: '', autoResume: due });
    const hint = pausedBannerHint(PAUSE_REASON_QUALITY_BELOW_BAR, due);
    h.ok(head.includes(`第 ${due.grants}/${due.limit} 次`), 'A3 due=true 标题给出第 k/上限 次', head);
    h.ok(hint.includes('无需手动点'), 'A3 due=true 提示不必手动恢复', hint);
    h.ok(hint.includes('作废本次自动续跑'), 'A3 due=true 提示手动恢复即接管作废', hint);
    h.ok(hint.includes(`${due.resumeBonus} 步`), 'A3 due=true 提示本次续额步数', hint);

    // due=false 必须逐字节回到旧文案——两只标本（验收未过 / 兜底），且"不传"与"传了 due=false"同文。
    const notDue = { due: false, reason: '停因是用户中止/暂停，不自动续跑', grants: 0, limit: STEP_CAP_GRANT_LIMIT, resumeBonus: 0 };
    const oldSpecimens: Array<{
      name: string; input: { reason: string; reasonLabel?: string; failed?: number; total?: number };
      head: string; hint: string;
    }> = [
      {
        name: '验收未过',
        input: { reason: PAUSE_REASON_ACCEPTANCE_FAILED, reasonLabel: '', failed: 1, total: 2 },
        head: '已暂停：验收未通过（1 条未达 / 共 2 条）',
        hint: '交付了但判卷未过——先看下方「验收标准核对」的未达理由，修完再「恢复」；确认无需返工可「标记完成」。',
      },
      {
        name: '兜底（质量分未达）',
        input: { reason: PAUSE_REASON_QUALITY_BELOW_BAR, reasonLabel: '' },
        head: '已暂停：质量分未达交付标准',
        hint: '执行已挂起，可恢复继续。',
      },
    ];
    for (const s of oldSpecimens) {
      h.eq(pausedBannerHeadline(s.input), s.head, `A3 ${s.name}：旧标题逐字节不变（未传 autoResume）`);
      h.eq(pausedBannerHeadline({ ...s.input, autoResume: notDue }), s.head, `A3 ${s.name}：due=false 标题逐字节不变`);
      h.eq(pausedBannerHint(s.input.reason), s.hint, `A3 ${s.name}：旧提示逐字节不变（未传 autoResume）`);
      h.eq(pausedBannerHint(s.input.reason, notDue), s.hint, `A3 ${s.name}：due=false 提示逐字节不变`);
    }
  }

  // ── A4 接管即作废 ───────────────────────────────────────────────────────
  {
    const ctx = stepCapCtx();
    h.eq(autoResumeViewOf(ctx).due, true, 'A4 前置：接管前 due=true');
    voidStepCapAutoResume(ctx);
    const after = autoResumeViewOf(ctx);
    h.eq(after.due, false, 'A4 接管（清 step_cap_hit）后 due=false');
    h.eq(ctx.step_budget_bonus, 74, 'A4 续额本身仍有效（只作废"替人继续"）');
    h.eq(ctx.step_cap_grants, 1, 'A4 续额次数账保留');
  }

  // ── A5 时间线事件（静态扫：调度器落 `step_cap_auto_resume` 信号）────────────────
  {
    const src = fs.readFileSync(path.join(h.root, h.A, 'src/main/core/task-scheduler.ts'), 'utf-8');
    h.ok(src.includes('step_cap_auto_resume'), 'A5 调度器引用 step_cap_auto_resume 信号名');
    h.ok(
      /eventBus\.emit\(\s*'task\.execution_signal'\s*,\s*\{[\s\S]{0,600}?signalType:\s*'step_cap_auto_resume'/.test(src),
      'A5 信号经 task.execution_signal 持久事件发出',
    );
    h.ok(/stepCapContinuationOf\s*\(/.test(src), 'A5 续额步数由 stepCapContinuationOf 回读（不手抄）');
  }

  // ── A6 手动恢复仍可达（静态扫：按钮与文案没被删）──────────────────────────
  {
    const src = fs.readFileSync(path.join(h.root, h.A, 'renderer/src/pages/TaskDetailPage.tsx'), 'utf-8');
    h.ok(/handleResume\(\s*task(?:!)?\.id\s*\)/.test(src), 'A6 暂停横幅的「恢复」仍调用 handleResume(task.id)');
    h.ok(src.includes('立即恢复（接管）'), 'A6 due=true 时按钮文案为「立即恢复（接管）」');
    h.ok(/autoResume\??\.due\s*\?[^\n]{0,160}立即恢复（接管）/.test(src), 'A6 该文案由 autoResume.due 条件派生');
    h.ok(/pausedBannerHeadline\(\{[\s\S]{0,600}?autoResume/.test(src), 'A6 autoResume 传入暂停横幅标题');
    h.ok(/pausedBannerHint\([^)]{0,200}autoResume/.test(src), 'A6 autoResume 传入暂停横幅提示');
  }
}
