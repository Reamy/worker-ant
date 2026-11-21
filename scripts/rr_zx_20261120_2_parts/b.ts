/**
 * zx_20261120_2 B 组「通」——工具拒因给对路。
 *
 * 归属：M2。实施者只改本文件与 M2 的生产代码，不碰其它分组。
 *
 * 纪律：直引生产真实现（`tool-guards.ts`），两处逐调用拒绝走同一个纯函数；
 * 「拒仍是拒」用两只标本证明判据未被文案改动顺手放宽。
 */
import type { RrHarness } from '../rr_zx_20261120_2.js';
import {
  explorationDenialReason,
  shellRejectAdvice,
  classifyShellReject,
  validateReadonlyBashCommand,
  buildToolConstraintBrief,
} from '../../apps/worker-ant-desktop/src/main/core/tool-guards.js';

export function runB(h: RrHarness): void {
  // B1：两种 kind 的逐调用拒绝都点名不占配额的替代（read_file / search_content）
  const quotaMsg = explorationDenialReason('execute_command', 20, 'quota');
  const convergeMsg = explorationDenialReason('bash', 15, 'converge');
  for (const [name, msg] of [['quota', quotaMsg], ['converge', convergeMsg]] as const) {
    h.ok(msg.includes('read_file') && msg.includes('search_content'), `B1 ${name} 拒绝文案点名免费替代`, msg.slice(0, 60));
  }

  // B2：execute_command 管道拒因给出「输出已自动截断」并指向 bash
  const pipeAdvice = shellRejectAdvice('|', 'execute_command', '/repo');
  h.ok(pipeAdvice.includes('输出已自动截断') && pipeAdvice.includes('bash'), 'B2 管道拒因给出截断事实与替代工具', pipeAdvice.slice(0, 80));

  // B3：bash cd 拒因给出两条真能执行的出路（execute_command / -f）
  const cdMulti = validateReadonlyBashCommand('cd backend && ls', { allowMultiSegment: true });
  const cdErr = cdMulti.ok ? '' : String(cdMulti.payload.error ?? '');
  h.ok(!cdMulti.ok && cdErr.includes('-f') && cdErr.includes('execute_command'), 'B3 cd 拒因给出 -f 与 execute_command', cdErr);

  // B4：判据未放宽——bash 仍拒 cd、execute_command 仍拒管道
  h.ok(validateReadonlyBashCommand('cd backend').ok === false, 'B4a bash 仍拒 cd');
  h.ok(classifyShellReject('echo x | grep y', 'execute_command', '/repo').ok === false, 'B4b execute_command 仍拒管道');

  // B5：能力简报补上组合场景（cd + 管道）的真写法
  const brief = buildToolConstraintBrief();
  h.ok(brief.includes('组合场景') && brief.includes('-f') && brief.includes('输出自动截断'), 'B5 能力简报含组合场景与两条出路');
}
