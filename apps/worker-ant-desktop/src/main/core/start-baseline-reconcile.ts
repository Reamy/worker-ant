/**
 * zx_20261119_2 M2「账」——**开局改动 vs 本轮改动**的对账（纯函数 + 一个有界的落库取数器）。
 *
 * 病根（真标本 S4）：怡寿里任务的「方案收口与提交」把**开工前就已暂存**的两笔删除
 * （`application-it.yml` / `application-local.yml`）原样 commit，完成报告只写「工作区干净」。
 * 起点基线本身早就有（`run_start_baseline`），但**没有任何一处拿它与"提交了什么"对账**。
 *
 * 本模块只做三件事：
 *   1. `reconcileStartBaseline`：把「开局既有 / 本轮新增 / 开局已消失」分成三组（纯函数）；
 *   2. `buildBaselineReconcileChecks`：把三组渲染成收口账的 INFO/WARN 行（纯函数）；
 *   3. `baselineReconcileChecks`：从库读基线 + 现采工作树 + （提交类任务）读报告正文 → 一次给全。
 *
 * 边界：**只提示，不阻断、不提交**。报告正文匹配是包含式（提到文件名即算说明），宁可少报不作假。
 */
import fs from 'node:fs';
import type Database from 'better-sqlite3';
import { collectRepoStatuses, statusPaths } from './working-tree.js';
import { readRunStartBaseline, type RunStartBaseline } from './run-baseline.js';

export interface BaselineReconcile {
  /** 开局就存在、现在仍在（非本轮产生） */
  preexisting: string[];
  /** 现在有、开局没有（本轮产生） */
  added: string[];
  /** 开局有、现在没了（本轮删掉或提交掉了） */
  vanished: string[];
}

/** 三组分流。`baseline=null` ⇒ 全部算「本轮新增」会对历史任务误报，故调用方应先判空。 */
export function reconcileStartBaseline(
  baseline: RunStartBaseline | null | undefined,
  currentPaths: string[],
): BaselineReconcile {
  const before = new Set([...(baseline?.untracked ?? []), ...(baseline?.modified ?? [])]);
  const now = new Set(currentPaths);
  const preexisting: string[] = [];
  const added: string[] = [];
  const vanished: string[] = [];
  for (const p of now) (before.has(p) ? preexisting : added).push(p);
  for (const p of before) if (!now.has(p)) vanished.push(p);
  return { preexisting: preexisting.sort(), added: added.sort(), vanished: vanished.sort() };
}

/** 提交/收口类任务——报告里必须解释"开局既有改动"。 */
const COMMIT_LIKE_RE = /提交|收口|入库|commit/i;
export function isCommitLikeTask(title: string, description: string): boolean {
  return COMMIT_LIKE_RE.test(`${title ?? ''} ${description ?? ''}`);
}

function shown(list: string[], limit: number): string {
  const head = list.slice(0, limit);
  return head.join('、') + (list.length > head.length ? ` 等 ${list.length} 项` : '');
}

export interface ReconcileCheckOptions {
  title?: string;
  description?: string;
  /** 报告正文（提交类任务用它判"是否逐条说明"）；不传则不查 */
  reportText?: string;
  limit?: number;
}

/** 纯渲染：返回要并入 `finalize_checks` 的行（无内容则空数组）。 */
export function buildBaselineReconcileChecks(groups: BaselineReconcile, opts: ReconcileCheckOptions = {}): string[] {
  const limit = Math.max(1, opts.limit ?? 10);
  const out: string[] = [];
  if (groups.preexisting.length > 0) {
    out.push(`[INFO] 开局既有改动 ${groups.preexisting.length} 项（非本轮产生，提交时须单列说明）：${shown(groups.preexisting, limit)}`);
  }
  if (groups.added.length > 0) {
    out.push(`[WARN] 本轮新增改动 ${groups.added.length} 项：${shown(groups.added, limit)}`);
  }
  if (groups.vanished.length > 0) {
    out.push(`[INFO] 开局既有改动中有 ${groups.vanished.length} 项在本轮已消失：${shown(groups.vanished, limit)}`);
  }
  const reportText = String(opts.reportText ?? '');
  if (reportText && groups.preexisting.length > 0 && isCommitLikeTask(opts.title ?? '', opts.description ?? '')) {
    const silent = groups.preexisting.filter((p) => {
      const base = p.split(/[\\/]/).pop() || p;
      return !reportText.includes(p) && !reportText.includes(base);
    });
    if (silent.length > 0) {
      out.push(`[WARN] 报告未逐条说明以下开局既有改动（它们不是本轮产生）：${shown(silent, limit)}`);
    }
  }
  return out;
}

/** 读任务名下 doc 产出物正文（有界：最多 3 份、每份 200KB；读不到就如实跳过）。 */
function readReportText(db: Database.Database, taskId: string): string {
  try {
    const rows = db.prepare("SELECT file_path FROM wa_deliverables WHERE task_id = ? AND type = 'doc' AND file_path IS NOT NULL")
      .all(taskId) as Array<{ file_path: string }>;
    const parts: string[] = [];
    for (const r of rows.slice(0, 3)) {
      try {
        const stat = fs.statSync(r.file_path);
        if (stat.size > 200 * 1024) continue;
        parts.push(fs.readFileSync(r.file_path, 'utf-8'));
      } catch { /* 单份读不到 ⇒ 跳过 */ }
    }
    return parts.join('\n');
  } catch {
    return '';
  }
}

/**
 * 落库取数器：基线（库）+ 现状（现采工作树）+ 可选报告正文 → 收口账行。
 * 无基线 ⇒ 空数组（不拿"没有基线"当"开局全干净"）。
 */
export function baselineReconcileChecks(
  db: Database.Database,
  taskId: string,
  workingDir: string,
  opts: { includeReportText?: boolean; limit?: number } = {},
): string[] {
  const baseline = readRunStartBaseline(db, taskId);
  if (!baseline) return [];
  const current = collectRepoStatuses(workingDir).flatMap(statusPaths);
  const groups = reconcileStartBaseline(baseline, current);
  let title = '';
  let description = '';
  try {
    const row = db.prepare('SELECT title, description FROM wa_tasks WHERE id = ?').get(taskId) as
      { title?: string; description?: string } | undefined;
    title = String(row?.title ?? '');
    description = String(row?.description ?? '');
  } catch { /* 取不到题面 ⇒ 分支类判据退化为不查报告 */ }
  const reportText = opts.includeReportText === false ? '' : readReportText(db, taskId);
  return buildBaselineReconcileChecks(groups, { title, description, reportText, limit: opts.limit });
}
