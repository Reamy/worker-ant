/**
 * zx_20261103_1 受控复跑 —— 「续」：完成不是句号，追加一句话就能接着干。
 *
 * 本轮只做一件事：任务详情页中，状态为「已完成」的任务也能追加输入，让任务重开继续跑。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * §A 判据 —— `shouldForceFinalize`（`core/resume-finalize.ts`，纯函数，零依赖）。
 *   旧内联判据（根任务 + 子任务全终态 ⇒ 强收）保留其系统唤醒语义；新增 `fromCompleted` 一维：
 *   用户从已完成态追加输入的那一次**永不强收**（那消息是人的新指令，不是系统收口）。
 *   两侧标本：应命中的（根+全终态、混合 completed/failed）与不应命中的（非根、空子集、有未完成子、
 *   已完成重开、来源缺省）。
 *
 * §B 接线 —— main（`feedback_equivalence_needs_wiring_criterion`）。
 *   `task:resume` 守卫接受 completed；`fromCompleted` 由**状态当场派生**；只有这一条恢复路把它带进载荷；
 *   `resume-ai-task` 只经 `shouldForceFinalize` 判定（旧内联 `children.every(...)` 已不在）；
 *   `composeResumeInput` 本体未动（rr_zx_20260915 的 r3/r5 仍成立）。
 *
 * §C 接线 —— renderer。已完成任务出现「追加输入」；提交按状态选路：completed ⇒ `tasks.resume`，
 *   执行中 ⇒ 仍 `tasks.inject`（反证：没有把注入路线一起改掉）。
 *
 * ── 纪律 ─────────────────────────────────────────────────────────────────────
 *   G-1 调生产导出，不复刻等价物；G-2 两侧标本；G-5 静态判据读原文（去注释仅在判「代码是否真调」时用）；
 *   G-6 零轮次字面量：本轮标识与方案路径由 `path.basename(__filename)` 派生。
 *   ⚠ 断言文案不得含失败字形（全量汇总器按日志字形计数）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';
import { shouldForceFinalize } from '../apps/worker-ant-desktop/src/main/core/resume-finalize.js';

let pass = 0; let fail = 0;

function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
function eq(actual: unknown, expect: unknown, label: string): void {
  const a = JSON.stringify(actual); const e = JSON.stringify(expect);
  ok(a === e, label, `${a} vs ${e}`);
}

const root = path.join(__dirname, '..');
/** 静态判据读**原文**；仅在判「代码里是否真调」时先去注释。 */
const RD = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf-8');
const CODE = (rel: string) => stripKeepingLines(RD(rel)).join('\n');
const SELF_ROUND = path.basename(__filename).replace(/^rr_/, '').replace(/\.ts$/, '');

const IPC = 'apps/worker-ant-desktop/src/main/ipc/project.ipc.ts';
const AI_TASK = 'apps/worker-ant-desktop/src/main/core/jobs/ai-task.ts';
const SETTLE = 'apps/worker-ant-desktop/src/main/core/pause-settlement.ts';
const PAGE = 'apps/worker-ant-desktop/renderer/src/pages/TaskDetailPage.tsx';

function main(): void {
  // ═══ §A 判据纯函数 ═════════════════════════════════════════════════════════
  console.log('\n【A】shouldForceFinalize —— 该收的收，该听人话的听人话');
  {
    eq(shouldForceFinalize({ source: 'user', childStatuses: ['completed', 'completed'], fromCompleted: false }), true,
      'A1 根任务 + 子任务全 completed ⇒ 强收（既有系统唤醒语义保留）');
    eq(shouldForceFinalize({ source: 'user', childStatuses: ['completed', 'failed'], fromCompleted: false }), true,
      'A2 根任务 + completed/failed 混合 ⇒ 强收（终态白名单仍是这两值）');
    eq(shouldForceFinalize({ source: 'user', childStatuses: ['completed', 'running'], fromCompleted: false }), false,
      'A3 有一个未完成子 ⇒ 不强收');
    eq(shouldForceFinalize({ source: 'user', childStatuses: [], fromCompleted: false }), false,
      'A4 无子任务 ⇒ 不强收');
    eq(shouldForceFinalize({ source: 'user', childStatuses: null, fromCompleted: false }), false,
      'A5 子任务缺省 ⇒ 不强收');
    eq(shouldForceFinalize({ source: 'subagent', childStatuses: ['completed'], fromCompleted: false }), false,
      'A6 非根任务 ⇒ 不强收（source 不是 user）');
    eq(shouldForceFinalize({ source: undefined, childStatuses: ['completed'], fromCompleted: false }), false,
      'A7 来源缺省 ⇒ 不强收');
    eq(shouldForceFinalize({ source: 'user', childStatuses: ['completed', 'completed'], fromCompleted: true }), false,
      'A8 已完成任务追加输入 ⇒ 不强收（本轮新增维度；消息就是人的新指令）');
    eq(shouldForceFinalize({ source: 'user', childStatuses: ['completed'], fromCompleted: true }), false,
      'A9 已完成重开且只剩一个终态子 ⇒ 仍不强收（不因子任务而翻案）');
  }

  // ═══ §B main 接线 ══════════════════════════════════════════════════════════
  console.log('\n【B】main 接线 —— 入口放开、标记随状态派生、判据只此一份');
  {
    const ipc = CODE(IPC);
    ok(ipc.includes("!['paused', 'failed', 'completed'].includes(task.status)"),
      'B1 task:resume 状态守卫接受 completed');
    ok(ipc.includes('只有暂停/失败/已完成的任务可以恢复'),
      'B2 拒绝文案与守卫一致（不谎报可接受的状态）');
    ok(ipc.includes("const fromCompleted = task.status === 'completed';"),
      'B3 fromCompleted 由**当时状态**派生（不信任调用方自报）');
    ok(ipc.includes('enqueueResumeJob(db, id, task.project_id, reply, fromCompleted);'),
      'B4 只有恢复路把 fromCompleted 带进载荷');
    ok(ipc.includes("...(fromCompleted ? { fromCompleted: true } : {})"),
      'B5 载荷缺省不带该键（其余两条恢复调用的形状零变）');
    eq((ipc.match(/enqueueResumeJob\(db, id, task\.project_id, reply, fromCompleted\)/g) || []).length, 1,
      'B6 带标记的入队恰一处（没有第二处自造恢复链）');
    ok(ipc.includes("if (!['executing', 'running', 'preparing'].includes(task.status))"),
      'B7 反证：task:inject 的守卫未被一起放宽（执行中注入语义不变）');

    const ai = CODE(AI_TASK);
    ok(ai.includes("import { shouldForceFinalize } from '../resume-finalize.js';"),
      'B8 resume-ai-task 引**唯一判据**而非内联复刻');
    ok(ai.includes('forceFinalize = shouldForceFinalize({'),
      'B9 forceFinalize 由该判据赋值');
    ok(ai.includes('fromCompleted: payload.fromCompleted === true,'),
      'B10 处理器只认载荷里的真值标记');
    ok(!ai.includes('children.every(c => c.status ==='),
      'B11 旧内联判据已不在（规则只此一份）');

    const settle = RD(SETTLE).replace(/\s+/g, ' ');
    ok(settle.includes('const finalMsg = !o.forceFinalize ? resumeMsg'),
      'B12 composeResumeInput 本体未动（已有强收语义仍按原分支）');
  }

  // ═══ §C renderer 接线 ══════════════════════════════════════════════════════
  console.log('\n【C】renderer 接线 —— 已完成有入口，按状态选路');
  {
    const page = RD(PAGE);
    ok(page.includes("(task.status==='executing'||task.status==='running'||task.status==='paused'||task.status==='failed'||task.status==='completed') && <ActionSlot>"),
      'C1 动作槽条件纳入 completed');
    ok(page.includes('title="追加输入（任务重新打开并带此输入继续）"'),
      'C2 已完成任务的按钮如实说明「重新打开并继续」');
    ok(page.includes("showInject && (task.status==='executing'||task.status==='running'||task.status==='completed')"),
      'C3 内联输入框在已完成态可见');
    ok(page.includes("if (status === 'completed')") && page.includes('await tasks.resume(taskId, text);'),
      'C4 completed 分支走 task:resume（保留对话继续）');
    ok(page.includes('await tasks.inject(taskId, text);'),
      'C5 反证：执行中分支仍走 task:inject（注入路线未被一起改掉）');
    ok(page.includes('handleInject(task.id, task.status)'),
      'C6 提交时把当前状态交给选路器（不在 handler 里凭旧闭包猜）');
    ok(page.includes("placeholder={task.status==='completed' ? '输入要追加的内容"),
      'C7 占位文案按状态区分，不把两种语义说成一种');
  }

  // ═══ §S 哑雷自检 + build 钉 ════════════════════════════════════════════════
  console.log('\n【S】哑雷自检 + build 钉（派生核对，不写轮次字面量）');
  {
    const selfLines = stripKeepingLines(RD(`scripts/${path.basename(__filename)}`)).join('\n');
    const selfPins = [...selfLines.matchAll(/(?<![A-Za-z0-9_])(?:build:\s*|ROUND\s*=\s*|includes\()'(zx_[0-9_]+)'/g)];
    ok(selfPins.length === 0, 'S1 本文件零 build 轮次字面量（G-6：不写"只为下一轮"的哑雷）',
      selfPins.map((m) => m[1]).join(',') || '0 处');
    ok(/zx_\d{8}/.test(SELF_ROUND) && fs.existsSync(path.join(root, `plans/improve/${SELF_ROUND}.md`)),
      'S2 方向性自指（由载体自身派生）：本轮方案文件在场', `plans/improve/${SELF_ROUND}.md`);
    ok(fs.existsSync(path.join(root, `scripts/rr_${SELF_ROUND}.ts`)),
      'S3 本套件在册（脚本名由载体派生）', `scripts/rr_${SELF_ROUND}.ts`);

    checkBuildPins(ok, { distDir: path.join(root, 'apps/worker-ant-desktop/dist') });
  }
}

// ⚠ `catch` 不可省：抛异常时必须记失败，否则进程被带走 ⇒ 假绿。
try {
  main();
} catch (e: unknown) {
  console.error(`\n💥 rr_zx_20261103_1 未捕获异常（复跑**未跑完**，不得读作通过）：`, e);
  fail++;
} finally {
  console.log(`\n${fail === 0 ? '✅' : '❌'} rr_zx_20261103_1: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
}
