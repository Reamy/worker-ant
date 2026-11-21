/**
 * zx_20261116_3 M3「判」：run 起点基线——到底哪些未跟踪/已修改文件在**本 run 开始前**就存在。
 *
 * 病根（真标本 `e32ed84f`）：验收判据「不改任何业务源码与测试源码（只读）」，
 * 验收 LLM 从证据串里的 `git status` 看到 `DevProfileConfigResolutionTest.java`，
 * 判成“本任务新增了测试源码”——而该文件 **birth=11月13日**，早于 11月16日的本任务。
 * 没有起点基线，历史遗留与兄弟任务的未提交文件都会被算到当前任务头上。
 *
 * 做法：run 开始（认领成功、`ctx.runId` 生成）后，在工作目录及其一层子仓上各跑一次
 * `git status --porcelain`（单仓 3s、总 6s），把未跟踪/已修改清单写进 `context_json.run_start_baseline`
 * （`json_set`，只保留最近一次 run）。验收证据串带 `[run 起点基线]`，判卷据此**扣除**起点已有的文件。
 *
 * zx_20261119_2 M2「账」：**跨仓采集**。旧实现只认 `workingDir/.git`，项目根不是仓、子目录才是仓
 * （怡寿里 `/代码`）时基线恒 `null`，开局既有的改动整笔丢失。现由 `working-tree.collectRepoStatuses`
 * 按 `repo-boundary` 的事实逐仓采集；`repos` 保留逐仓明细，顶层 `untracked/modified` 为并集。
 *
 * 零 electron 依赖（只用 node:child_process/fs/path），rr 可直跑。
 */
import type Database from 'better-sqlite3';
import { collectRepoStatuses, statusPaths, type RepoWorktreeStatus } from './working-tree.js';

export interface RunStartBaseline {
  runId: string;
  at: string;
  /** 全部仓的并集（路径相对工作目录；子仓带前缀，见 `working-tree.toWorkingDirPath`） */
  untracked: string[];
  modified: string[];
  /** zx_20261119_2 M2：逐仓明细——子仓布局下「哪一笔属于哪个仓」一眼可查 */
  repos?: Array<{ root: string; rel: string; untracked: string[]; modified: string[] }>;
}

/**
 * 采集起点基线。
 *
 * zx_20261119_2 M2：改为**跨仓**采集——工作目录本身不是 git 仓、而一层子目录是仓时
 * （怡寿里 `/代码` 即此形），旧实现直接返回 `null`，开局既有改动整笔丢失。
 * 非 git 布局 / git 不可用 / 超时 ⇒ `null`（不编“已基线”）。
 */
export function captureRunStartBaseline(workingDir: string, runId: string): RunStartBaseline | null {
  const statuses: RepoWorktreeStatus[] = collectRepoStatuses(workingDir);
  if (statuses.length === 0) return null;
  const untracked: string[] = [];
  const modified: string[] = [];
  const seen = new Set<string>();
  for (const st of statuses) {
    for (const p of st.untracked) {
      const rel = statusPaths({ ...st, untracked: [p], modified: [] })[0]!;
      if (!seen.has(`u:${rel}`)) { seen.add(`u:${rel}`); untracked.push(rel); }
    }
    for (const p of st.modified) {
      const rel = statusPaths({ ...st, untracked: [], modified: [p] })[0]!;
      if (!seen.has(`m:${rel}`)) { seen.add(`m:${rel}`); modified.push(rel); }
    }
  }
  return {
    runId,
    at: new Date().toISOString(),
    untracked,
    modified,
    repos: statuses.map((s) => ({ root: s.root, rel: s.rel, untracked: s.untracked, modified: s.modified })),
  };
}

/** `json_set` 写 `$.run_start_baseline`（只动这一格，不覆盖兄弟键）。 */
export function writeRunStartBaseline(
  db: Database.Database,
  taskId: string,
  baseline: RunStartBaseline,
): void {
  try {
    db.prepare(
      "UPDATE wa_tasks SET context_json = json_set(COALESCE(context_json, '{}'), '$.run_start_baseline', json(?)) WHERE id = ?",
    ).run(JSON.stringify(baseline), taskId);
  } catch {
    /* 基线写不成不阻断执行；验收侧读不到就不扣，不编 */
  }
}

export function readRunStartBaseline(db: Database.Database, taskId: string): RunStartBaseline | null {
  try {
    const row = db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json?: string } | undefined;
    const ctx = JSON.parse(row?.context_json || '{}') as { run_start_baseline?: unknown };
    const b = ctx.run_start_baseline as {
      runId?: unknown; at?: unknown; untracked?: unknown; modified?: unknown; repos?: unknown;
    } | undefined;
    if (!b || typeof b !== 'object') return null;
    const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
    const repos = Array.isArray(b.repos)
      ? b.repos
        .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
        .map((r) => ({
          root: typeof r.root === 'string' ? r.root : '',
          rel: typeof r.rel === 'string' ? r.rel : '',
          untracked: strList(r.untracked),
          modified: strList(r.modified),
        }))
        .filter((r) => r.root)
      : [];
    return {
      runId: typeof b.runId === 'string' ? b.runId : '',
      at: typeof b.at === 'string' ? b.at : '',
      untracked: strList(b.untracked),
      modified: strList(b.modified),
      ...(repos.length ? { repos } : {}),
    };
  } catch {
    return null;
  }
}
