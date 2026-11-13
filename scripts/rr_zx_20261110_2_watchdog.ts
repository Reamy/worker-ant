/**
 * zx_20261110_2 B1 复跑 —— 「恒」：**"多久没动静"才是判据，"过了多久"不是**。
 *
 * 真标本：任务 339ef167 整轮只有一条 600s **绝对**超时；那一次 abort 发出后 `streamText` 不兑现，
 * 执行体永不返回，此后 73 分钟没有任何一层知道"这轮已经没救了"。
 *
 * 五组判据（全部假时钟直跑 `core/exec-watchdog.ts`，不依赖真实墙钟）：
 *   W-1 「还在动」不误杀：每 30s 一步、连走 10 分钟 ⇒ 永不出裁决；
 *   W-2 「没动静」判得出：最后一步后 181s ⇒ `abort`，且 `abortsSent` **恰一次**（不连发）；
 *   W-3 「喊了没人应」判得出：abort 后 31s 仍无 finally ⇒ `orphan`；判过即止（不重复记账）；
 *   W-4 边界与长工具：单次长工具 60s / 179s 都不杀，整 180s 才杀（阈值是"到"不是"过"）；
 *   W-5 影子模式：`WATCHDOG_MODE=log` ⇒ 只记录不中止，且**不碰 abort 记账**（不得把"判出来"冒充"发出去"）。
 *
 * 纪律（承 auto-memory）：
 *   G-1 真源直 import（改签名即编译期红）；
 *   G-2 两只标本（该触发的触发 / 不该触发的纹丝不动）；
 *   G-4 计数器断言必有 0→1 正面；
 *   G-6 无轮次字面量（轮次由 `path.basename(__filename)` 派生，只做方向性比较）；
 *   ⚠ 判据文案不得含失败字形（全量汇总按字形计失败数）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { checkBuildPins, stripKeepingLines, buildNotOlderThan } from './lib/rr-pins.js';
import {
  DEFAULT_WATCHDOG,
  createWatchdogState,
  touchActivity,
  touchStep,
  noteAbortSent,
  noteAbortObserved,
  noteOrphaned,
  watchdogVerdict,
  watchdogMode,
  watchdogConfig,
} from '../apps/worker-ant-desktop/src/main/core/exec-watchdog.js';

let pass = 0; let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  PASS ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}
function eq(actual: unknown, expect: unknown, label: string): void {
  const a = JSON.stringify(actual); const e = JSON.stringify(expect);
  ok(a === e, label, `${a} vs ${e}`);
}

const root = path.join(__dirname, '..');
/**
 * G-6：轮次由**载体自身**派生——本文件不写任何轮次字面量。
 * 取 `rr_<轮次>[_<批次>].ts` 里的**轮次段**（`zx_YYYYMMDD[_x]`）；批次后缀不属轮次，须剥掉，
 * 否则 `buildNotOlderThan` 解析失败（形状不认即 false）⇒ 方向性比较恒红。
 */
const SELF_ROUND = /^(zx_\d{8}(?:_\d+)?)/.exec(path.basename(__filename).replace(/^rr_/, '').replace(/\.ts$/, ''))?.[1] ?? '';
const A = 'apps/worker-ant-desktop';
const CODE = (rel: string) => stripKeepingLines(fs.readFileSync(path.join(root, rel), 'utf-8')).join('\n');

const T0 = 1_700_000_000_000;

function main(): void {
  // ═══ K｜构建钉 ══════════════════════════════════════════════════════════
  console.log(`\n【K】构建钉（${SELF_ROUND}）`);
  checkBuildPins(ok, { distDir: path.join(A, 'dist') });
  // 方向性比较：当前 build 快照**不早于**本脚本轮次（不是 `===` 那种只对下一轮引爆的哑雷）。
  const src = fs.readFileSync(path.join(root, `${A}/src/main/core/agent-executor.ts`), 'utf-8');
  const tag = /build:\s*'(zx_[0-9_]+)'/.exec(stripKeepingLines(src).join('\n'))?.[1] ?? '';
  ok(!!tag && buildNotOlderThan(tag, SELF_ROUND), '当前 build 快照不早于本脚本轮次（方向性比较）', `${tag} vs ${SELF_ROUND}`);

  // ═══ W-1｜还在动 ⇒ 不误杀 ════════════════════════════════════════════════
  console.log('\n【W-1】每 30s 一步、连走 10 分钟 ⇒ 永不出裁决');
  {
    const s = createWatchdogState(T0);
    const actions: string[] = [];
    // 每 15s 取一次裁决（与生产 `pollMs` 同频），每 30s 完成一步。
    for (let t = 0; t <= 600_000; t += 15_000) {
      if (t > 0 && t % 30_000 === 0) touchStep(s, T0 + t);
      actions.push(watchdogVerdict(s, T0 + t).action);
    }
    ok(actions.every((a) => a === 'none'), 'W-1a ★步骤每 30s 一跳 ⇒ 41 次裁决全为 none（绝对时长不判死）',
      `实测 actions=${Array.from(new Set(actions)).join(',')}`);
    eq(s.abortsSent, 0, 'W-1b 全程零 abort（0 是正面断言，不是"没抛"）');
    eq(s.lastStepAt, T0 + 600_000, 'W-1c 最后一步时刻如实推进（touch 生效）');
  }

  // ═══ W-2｜没动静 ⇒ 判得出，且只喊一次 ══════════════════════════════════
  console.log('\n【W-2】最后一步后 181s 无活动 ⇒ abort 恰一次');
  {
    const s = createWatchdogState(T0);
    touchStep(s, T0 + 30_000);
    const last = T0 + 30_000;

    eq(watchdogVerdict(s, last + 179_000).action, 'none', 'W-2a 179s 未到阈值 ⇒ 不动（两侧标本的"不该动"）');
    const v180 = watchdogVerdict(s, last + 180_000);
    eq(v180.action, 'abort', 'W-2b ★整 180s 到阈值 ⇒ abort（阈值是"到"不是"过"）');
    eq(v180.reason, 'watchdog_idle_timeout', 'W-2c 因由可读（进事件 payload 与日志）');
    eq(v180.idleMs, 180_000, 'W-2d 报出的 idleMs 与真值一致');

    // 取到 abort 之后才记账（生产里也是先判后记）
    noteAbortSent(s, last + 180_000);
    eq(s.abortsSent, 1, 'W-2e ★abortsSent 0→1');
    // 下一次轮询（orphan 窗口内）不得再发一次裁决——避免"喊话连发"淹没真因
    eq(watchdogVerdict(s, last + 195_000).action, 'none', 'W-2f abort 后 15s ⇒ none（给执行体收尾的窗口，不连发）');
    eq(s.abortsSent, 1, 'W-2g 仍只有一次 abort');
    eq(watchdogVerdict(s, last + 209_000).action, 'none', 'W-2h abort 后 29s ⇒ none（窗口未满）');
  }

  // ═══ W-3｜喊了没人应 ⇒ 判孤儿 ═══════════════════════════════════════════
  console.log('\n【W-3】abort 后 31s 仍无 finally ⇒ orphaned');
  {
    const s = createWatchdogState(T0);
    noteAbortSent(s, T0);
    eq(watchdogVerdict(s, T0 + 30_000).action, 'orphan', 'W-3a ★30s 未观测到 ⇒ 判孤儿（喊了没人应必须能被判出）');
    const v = watchdogVerdict(s, T0 + 30_000);
    eq(v.reason, 'abort_not_observed', 'W-3b 因由与"空闲超时"分开（两种死法不混）');
    eq(s.orphanedAt, null, 'W-3c 裁决是纯函数——取裁决不改状态');

    noteOrphaned(s, T0 + 30_000);
    eq(s.orphanedAt, T0 + 30_000, 'W-3d 判定留痕（注销句柄的凭据）');
    eq(watchdogVerdict(s, T0 + 300_000).action, 'none', 'W-3e 判过即止（不重复记账，不再判）');

    // 反证：abort 被观测到 ⇒ 永不 orphan
    const s2 = createWatchdogState(T0);
    noteAbortSent(s2, T0);
    noteAbortObserved(s2, T0 + 5_000);
    eq(watchdogVerdict(s2, T0 + 600_000).action, 'none', 'W-3f ★abort 被观测到（执行体收尾走到）⇒ 永不判孤儿');
    eq(s2.abortObservedAt, T0 + 5_000, 'W-3g 观测时刻只认第一次');
    noteAbortObserved(s2, T0 + 9_000);
    eq(s2.abortObservedAt, T0 + 5_000, 'W-3h 后续观测不改写记录');
  }

  // ═══ W-4｜单次长工具不误杀 ═══════════════════════════════════════════════
  console.log('\n【W-4】单次长工具 60s / 179s 不误杀');
  {
    const s = createWatchdogState(T0);
    touchActivity(s, T0); // 工具开始
    eq(watchdogVerdict(s, T0 + 60_000).action, 'none', 'W-4a 单次长工具 60s ⇒ 不杀（远小于 180s）');
    touchActivity(s, T0 + 60_000); // 工具结束也推一次
    eq(s.lastActivityAt, T0 + 60_000, 'W-4b 工具**结束**同样推一次活动时刻（开始/结束都算"还在动"）');
    eq(watchdogVerdict(s, T0 + 60_000 + 179_000).action, 'none', 'W-4c 工具结束后 179s ⇒ 仍不杀');
    eq(watchdogVerdict(s, T0 + 60_000 + 181_000).action, 'abort', 'W-4d 工具结束后 181s ⇒ 杀（该杀时才杀）');
    // 空工具（零推进）不得把时刻往回拨
    eq(touchActivity(s, T0), false, 'W-4e 时刻回拨的 touch 被拒（不因乱序把 idle 清零）');
  }

  // ═══ W-5｜影子模式 + 配置 ═══════════════════════════════════════════════
  console.log('\n【W-5】WATCHDOG_MODE=log 只记录不中止；阈值可配且非法回落');
  {
    eq(watchdogMode({} as NodeJS.ProcessEnv), 'enforce', 'W-5a 缺省 enforce（真中止）');
    eq(watchdogMode({ WATCHDOG_MODE: 'log' } as NodeJS.ProcessEnv), 'log', 'W-5b WATCHDOG_MODE=log ⇒ 影子');
    eq(watchdogMode({ WATCHDOG_MODE: ' LOG ' } as NodeJS.ProcessEnv), 'log', 'W-5c 大小写与空白归一');
    eq(watchdogMode({ WATCHDOG_MODE: 'off' } as NodeJS.ProcessEnv), 'enforce', 'W-5d 不认识的取值回落 enforce（不猜）');

    eq(watchdogConfig({} as NodeJS.ProcessEnv), DEFAULT_WATCHDOG, 'W-5e 缺省 180s / 30s / 15s');
    eq(watchdogConfig({ WATCHDOG_IDLE_SEC: '90', WATCHDOG_ORPHAN_SEC: '10', WATCHDOG_POLL_SEC: '5' } as NodeJS.ProcessEnv),
      { idleMs: 90_000, orphanMs: 10_000, pollMs: 5_000 }, 'W-5f 环境变量按秒覆盖');
    eq(watchdogConfig({ WATCHDOG_IDLE_SEC: '-5' } as NodeJS.ProcessEnv).idleMs, DEFAULT_WATCHDOG.idleMs,
      'W-5g 非正/非法回落缺省（不把 0 当"立刻杀"）');

    // 接线形状：log 分支里**不得**出现 `controller.abort` / `noteAbortSent`
    //   （判出来了 ≠ 发出去了；本轮红线：发了与停了分开记）。
    const ex = CODE(`${A}/src/main/core/agent-executor.ts`);
    const logIdx = ex.indexOf("if (wdMode === 'log')");
    const retIdx = logIdx >= 0 ? ex.indexOf('return;', logIdx) : -1;
    const logBranch = logIdx >= 0 && retIdx > logIdx ? ex.slice(logIdx, retIdx) : '';
    ok(logBranch !== '', 'W-5h 执行体里确有影子模式分支（真接线，不是只写了个常量）');
    ok(!/controller\.abort|noteAbortSent/.test(logBranch),
      'W-5i ★影子分支里既不 abort、也不记 abort_sent（不把"判出来"冒充"发出去"）',
      logBranch.match(/controller\.abort|noteAbortSent/)?.[0] ?? '');
    ok(/wdMode\s*===\s*'log'/.test(ex) && /'run\.watchdog_fired'/.test(ex),
      'W-5j 影子模式真发 `run.watchdog_fired`（影子跑一轮有账可查）');
    ok(/wd\.abortsSent\s*>\s*0\s*&&\s*wd\.abortObservedAt\s*===\s*null/.test(ex),
      'W-5k `run.abort_observed` 只在"先发过 abort 且未被观测"时才记（观测不凭空产生）');
  }

  // ═══ X｜接线在册 ════════════════════════════════════════════════════════
  console.log('\n【X】看门狗在执行体里真被驱动');
  {
    const ex = CODE(`${A}/src/main/core/agent-executor.ts`);
    ok(/setInterval\(\(\)\s*=>\s*\{/.test(ex), 'X-1 看门狗用**独立** setInterval（不搭整轮超时的便车）');
    ok(/watchdogConfig\(\)/.test(ex) && /watchdogMode\(\)/.test(ex), 'X-2 阈值与模式都从环境派生（不在执行体里手抄数字）');
    ok(/touchStep|touchActivity\(wdLocal/.test(ex), 'X-3 进展由 touch 兑现（步完成推一次）');
    ok(/for await \(const chunk of result\.fullStream\)[\s\S]{0,400}touchWd\(\);/.test(ex),
      'X-4 流分片即触活动（工具开始/结束都在流里 ⇒ 长工具不误杀）');
    ok(/unregisterTaskRun\(taskId, controller\)/.test(ex), 'X-5 判孤儿时注销句柄（让调度侧 `hasTaskRun` 读到 false）');
    ok(/if \(watchdogTimer\) clearInterval\(watchdogTimer\)/.test(ex), 'X-6 收尾清定时器（不留悬挂 interval）');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
