/**
 * zx_20261119_2 M2「账」——**跨仓工作树快照**（零 electron、零 better-sqlite3）。
 *
 * 病根（真标本 S4）：怡寿里的项目根不是 git 仓、`backend/` 与 `platform-web/` 才是独立仓。
 * 旧实现只认 `workingDir/.git` ⇒ run 起点基线恒 `null`，开局就暂存的删除既没进基线、
 * 也没进收口提示，最后被「提交」任务原样 commit，完成报告还写着「工作区干净」。
 *
 * 本模块只回答一个问题：**工作目录及其周围的受控仓库，此刻各自有哪些未提交/未跟踪条目**。
 * 边界由 `repo-boundary.collectRepoBoundary` 给（自身仓根 + 一层子仓），本模块只跑 `git status`。
 * 有界：单仓 3s、总预算 6s、每仓最多 200 行；超时/失败如实跳过，不编。
 *
 * ⚠ 与 `run-baseline.ts` / `git-advisory.ts` 的分工：本模块只采集，**不解释**；
 *   基线写入与收口对账由那两个消费者各取所需。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { collectRepoBoundary } from './repo-boundary.js';

export const WORKING_TREE_MAX_LINES = 200;
export const WORKING_TREE_TIMEOUT_MS = 3_000;
export const WORKING_TREE_TOTAL_BUDGET_MS = 6_000;

export interface RepoWorktreeStatus {
  /** 仓根绝对路径 */
  root: string;
  /** 相对工作目录的写法（`''` = 工作目录本身即仓根；`backend` = 一层子仓；`..` = 上级仓） */
  rel: string;
  untracked: string[];
  modified: string[];
  /** 该仓条目超过上限被截断 */
  truncated: boolean;
}

/** 解析 `git status --porcelain`（与 `run-baseline.ts` 既有口径逐字一致：`??` 算未跟踪，其余 M/D/A/R 算已修改）。 */
export function parsePorcelain(out: string, maxLines = WORKING_TREE_MAX_LINES): { untracked: string[]; modified: string[]; truncated: boolean } {
  const all = String(out ?? '').split('\n').filter(Boolean);
  const lines = all.slice(0, maxLines);
  const untracked: string[] = [];
  const modified: string[] = [];
  for (const line of lines) {
    const code = line.slice(0, 2);
    const file = line.slice(3).trim();
    if (!file) continue;
    if (code === '??') untracked.push(file);
    else if (code.includes('M') || code.includes('D') || code.includes('A') || code.includes('R')) modified.push(file);
  }
  return { untracked, modified, truncated: all.length > lines.length };
}

/** 条目路径换算成「相对工作目录」的写法（子仓前缀 `rel/`），供基线并集与报告核对同尺。 */
export function toWorkingDirPath(status: RepoWorktreeStatus, file: string): string {
  if (!status.rel) return file;
  return path.posix.join(status.rel.split(path.sep).join('/'), file.split(path.sep).join('/'));
}

/** 一个仓的全部改动路径（相对工作目录）。 */
export function statusPaths(status: RepoWorktreeStatus): string[] {
  return [...status.untracked, ...status.modified].map((f) => toWorkingDirPath(status, f));
}

function sameReal(a: string, b: string): boolean {
  try { return fs.realpathSync(a) === fs.realpathSync(b); } catch { return path.resolve(a) === path.resolve(b); }
}

export interface CollectWorktreeOptions {
  timeoutMs?: number;
  totalBudgetMs?: number;
  maxLines?: number;
}

/**
 * 采集工作目录及一层子仓的工作树状态。**永不抛**；非 git 布局 ⇒ `[]`（正常结论，不是故障）。
 * 只返回**有改动**的仓（干净仓不出现在结果里，避免下游把 0 项当"采到了"）。
 */
export function collectRepoStatuses(workingDir: string, opts: CollectWorktreeOptions = {}): RepoWorktreeStatus[] {
  const raw = String(workingDir ?? '').trim();
  if (!raw) return [];
  const abs = path.resolve(raw);
  let boundary: ReturnType<typeof collectRepoBoundary>;
  try { boundary = collectRepoBoundary(abs); } catch { return []; }

  const roots: Array<{ root: string; rel: string }> = [];
  const seen: string[] = [];
  const add = (root: string): void => {
    if (!root) return;
    if (seen.some((s) => sameReal(s, root))) return;
    seen.push(root);
    roots.push({ root, rel: path.relative(abs, root).split(path.sep).join('/') || '' });
  };
  if (boundary.selfIsRepo) add(abs);
  else if (boundary.toplevel) add(boundary.toplevel);
  for (const name of boundary.repos) add(path.join(abs, name));

  const timeoutMs = opts.timeoutMs ?? WORKING_TREE_TIMEOUT_MS;
  const totalBudgetMs = opts.totalBudgetMs ?? WORKING_TREE_TOTAL_BUDGET_MS;
  const maxLines = opts.maxLines ?? WORKING_TREE_MAX_LINES;
  const started = Date.now();
  const out: RepoWorktreeStatus[] = [];
  for (const r of roots) {
    const remain = totalBudgetMs - (Date.now() - started);
    if (remain <= 0) break;
    try {
      const text = execFileSync('git', ['-C', r.root, 'status', '--porcelain'], {
        encoding: 'utf8',
        timeout: Math.max(200, Math.min(timeoutMs, remain)),
        maxBuffer: 256 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const parsed = parsePorcelain(text, maxLines);
      if (parsed.untracked.length > 0 || parsed.modified.length > 0 || parsed.truncated) {
        out.push({ ...r, ...parsed });
      }
    } catch { /* 单仓失败 ⇒ 跳过（不因一个坏仓丢整份快照） */ }
  }
  return out;
}
