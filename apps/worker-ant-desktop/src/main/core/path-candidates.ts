/**
 * zx_20261119_2 M4「径」——**相对路径在子仓里的候选**（有界、零 electron）。
 *
 * 病根（真标本 S6）：任务文本写「新建 `utils/bank-codes.ts`」，文件实际落在
 * `platform-web/src/utils/bank-codes.ts`。代拟判据只按项目工作目录拼路径 ⇒ 恒 ✗，
 * 父任务详情出现一条假红（"产出写入指定路径：utils/bank-codes.ts"）。
 *
 * 取法（有界）：
 *   1. 先试 `<repo>/<literal>`（最便宜）；
 *   2. 再问 `git -C <repo> ls-files -- '*<literal>'`（快，且覆盖常见已跟踪文件）；
 *   3. 仍无 ⇒ 有界目录遍历（深度 ≤4、每仓 ≤1500 项、跳过 node_modules/dist/target 等）。
 * 每条字面量最多回 3 个候选；超出如实截断。非 git 仓/读不了 ⇒ 该仓跳过，不抛。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface PathCandidate {
  path: string;
  /** 候选所在的仓（展示用，如 `platform-web`） */
  label: string;
}

export interface CandidateRoot {
  root: string;
  label: string;
}

export interface FindCandidateOptions {
  /** 每条字面量最多回几个候选 */
  limit?: number;
  /** 总预算（毫秒），超出即停止继续找 */
  budgetMs?: number;
  /** 目录遍历的深度与项数上限 */
  maxDepth?: number;
  maxEntries?: number;
}

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'target', '__pycache__', '.git']);

function walkSuffix(root: string, literal: string, maxDepth: number, maxEntries: number): string[] {
  const hits: string[] = [];
  let visited = 0;
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (stack.length > 0 && visited < maxEntries && hits.length < 3) {
    const cur = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(cur.dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (visited++ >= maxEntries) break;
      if (e.name.startsWith('.')) continue;
      const full = path.join(cur.dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || cur.depth >= maxDepth) continue;
        stack.push({ dir: full, depth: cur.depth + 1 });
      } else if (e.isFile()) {
        const rel = path.relative(root, full).split(path.sep).join('/');
        if (rel === literal || rel.endsWith(`/${literal}`)) hits.push(full);
      }
    }
  }
  return hits;
}

function gitSuffix(root: string, literal: string): string[] {
  try {
    const out = execFileSync('git', ['-C', root, 'ls-files', '-z', '--', `*${literal}`], {
      encoding: 'utf8',
      timeout: 1_500,
      maxBuffer: 256 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return String(out).split('\0').filter(Boolean)
      .map((rel) => path.join(root, rel))
      .filter((p) => fs.existsSync(p));
  } catch {
    return [];
  }
}

/**
 * 在给定仓根里找「以该字面量结尾」的文件。返回绝对路径候选（已去重、按根顺序）。
 */
export function findPathCandidates(
  roots: CandidateRoot[],
  literal: string,
  opts: FindCandidateOptions = {},
): PathCandidate[] {
  const lit = String(literal ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!lit || path.isAbsolute(lit)) return [];
  const limit = Math.max(1, opts.limit ?? 3);
  const budgetMs = Math.max(50, opts.budgetMs ?? 500);
  const maxDepth = Math.max(1, opts.maxDepth ?? 4);
  const maxEntries = Math.max(50, opts.maxEntries ?? 1500);
  const started = Date.now();
  const out: PathCandidate[] = [];
  const seen = new Set<string>();
  const push = (p: string, label: string): void => {
    const key = (() => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } })();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ path: p, label });
  };
  for (const r of roots) {
    if (out.length >= limit) break;
    if (Date.now() - started > budgetMs) break;
    const direct = path.join(r.root, lit);
    if (fs.existsSync(direct)) push(direct, r.label);
    if (out.length >= limit) break;
    for (const p of gitSuffix(r.root, lit)) {
      if (out.length >= limit) break;
      push(p, r.label);
    }
    if (out.length >= limit) break;
    for (const p of walkSuffix(r.root, lit, maxDepth, maxEntries)) {
      if (out.length >= limit) break;
      push(p, r.label);
    }
  }
  return out.slice(0, limit);
}
