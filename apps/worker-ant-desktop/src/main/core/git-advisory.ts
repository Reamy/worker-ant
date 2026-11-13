/**
 * zx_20261113_2 M15——收口时的 **Git 未提交提示**（只提示，不自动提交）。
 *
 * 病根（2026-11-13 真标本）：任务产出 13 个未跟踪文件（配置/测试/诊断脚本），
 *   `finalize_checks` 只有世界模型审计，没有一个字提醒"项目约定要求提交"——用户不看工作树就不知道。
 *
 * 边界：本函数**只读** `git status --porcelain`，不 `add`/不 `commit`；非 git 目录、git 不可用、
 *   超时一律返回 `null`（best-effort，不阻断收口）。条目多时只列前 `limit` 项并如实报总数。
 */
import { execFileSync } from 'node:child_process';

export function gitWorkingTreeAdvice(cwd: string, limit = 20): string | null {
  if (!cwd) return null;
  try {
    const out = execFileSync('git', ['-C', cwd, 'status', '--porcelain'], {
      encoding: 'utf-8',
      timeout: 3_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const lines = String(out).split('\n').map((s) => s.trim()).filter(Boolean);
    if (lines.length === 0) return null;
    const shown = lines.slice(0, Math.max(1, limit));
    return `[INFO] git 工作树有 ${lines.length} 个未提交/未跟踪条目`
      + `${lines.length > shown.length ? `（前 ${shown.length} 项）` : ''}：${shown.join('；')}。`
      + '项目约定要求提交；引擎不自动提交。';
  } catch {
    return null;
  }
}
