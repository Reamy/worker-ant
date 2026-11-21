/**
 * zx_20261113_2 M15——收口时的 **Git 未提交提示**（只提示，不自动提交）。
 *
 * 病根（2026-11-13 真标本）：任务产出 13 个未跟踪文件（配置/测试/诊断脚本），
 *   `finalize_checks` 只有世界模型审计，没有一个字提醒"项目约定要求提交"——用户不看工作树就不知道。
 *
 * 边界：本函数**只读** `git status --porcelain`，不 `add`/不 `commit`；非 git 目录、git 不可用、
 *   超时一律返回 `null`（best-effort，不阻断收口）。条目多时只列前 `limit` 项并如实报总数。
 */
import { collectRepoStatuses } from './working-tree.js';

/**
 * 收口提示：**只读**工作树，不 `add`/不 `commit`。
 *
 * zx_20261119_2 M2：改为**跨仓**——工作目录不是仓、一层子目录才是仓时（怡寿里 `/代码`），
 * 旧的 `git -C cwd status` 必失败并静默返回 `null`，用户看不到任何未提交提示。
 * 单仓布局输出**逐字保持旧格式**（既有断言 X6 依赖它）；多仓时按仓分列。
 */
export function gitWorkingTreeAdvice(cwd: string, limit = 20): string | null {
  if (!cwd) return null;
  const statuses = collectRepoStatuses(cwd);
  if (statuses.length === 0) return null;
  const entries = statuses.map((st) => ({ rel: st.rel || '.', lines: [...st.untracked, ...st.modified] }));
  const total = entries.reduce((n, e) => n + e.lines.length, 0);
  if (total === 0) return null;

  if (statuses.length === 1) {
    const lines = entries[0]!.lines;
    const shown = lines.slice(0, Math.max(1, limit));
    return `[INFO] git 工作树有 ${lines.length} 个未提交/未跟踪条目`
      + `${lines.length > shown.length ? `（前 ${shown.length} 项）` : ''}：${shown.join('；')}。`
      + '项目约定要求提交；引擎不自动提交。';
  }

  const perRepo = entries.map((e) => {
    const shown = e.lines.slice(0, Math.max(1, Math.min(limit, 5)));
    return `${e.rel} ${e.lines.length} 项`
      + `${e.lines.length > shown.length ? `（前 ${shown.length}）` : ''}：${shown.join('；')}`;
  });
  return `[INFO] git 工作树跨 ${statuses.length} 个仓共 ${total} 个未提交/未跟踪条目：${perRepo.join('；')}。`
    + '项目约定要求提交；引擎不自动提交。';
}
