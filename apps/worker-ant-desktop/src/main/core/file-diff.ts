/**
 * 行级 diff 工具（零依赖 LCS 实现）。
 * 产出 hunks 结构，对齐 Claude Code StructuredPatchHunk 语义：
 * 每条 line 标 add/del/ctx，renderer 据此渲染 +/-(绿/红) 行。
 *
 * 大文件截断到 MAX_LINES 行，避免 LCS O(n*m) 内存/耗时爆炸。
 */

export interface DiffLine {
  type: 'add' | 'del' | 'ctx';
  content: string;
}

export interface DiffHunk {
  oldStart: number; // 1-based 旧文件起始行
  oldLines: number;
  newStart: number; // 1-based 新文件起始行
  newLines: number;
  lines: DiffLine[];
}

export interface DiffResult {
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
  truncated: boolean;
}

const MAX_LINES = 400;
const CONTEXT = 3;

interface Edit {
  type: 'add' | 'del' | 'ctx';
  oldLine: number; // 0-based
  newLine: number; // 0-based
  content: string;
}

/** 计算 before → after 的结构化 diff（新增/覆盖/编辑通用）。 */
export function computeDiff(before: string, after: string): DiffResult {
  let truncated = false;
  let bLines = toLines(before);
  let aLines = toLines(after);

  if (bLines.length > MAX_LINES || aLines.length > MAX_LINES) {
    truncated = true;
    bLines = bLines.slice(0, MAX_LINES);
    aLines = aLines.slice(0, MAX_LINES);
  }

  const edits = diffLines(bLines, aLines);
  const hunks = buildHunks(edits);

  let additions = 0;
  let deletions = 0;
  for (const h of hunks) {
    for (const l of h.lines) {
      if (l.type === 'add') additions++;
      else if (l.type === 'del') deletions++;
    }
  }
  return { hunks, additions, deletions, truncated };
}

/** 空文件视为 0 行；末尾换行产生的空行剥除，使行号与编辑器一致。 */
function toLines(s: string): string[] {
  if (s === '') return [];
  const lines = s.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** LCS 动态规划（bottom-up，用扁平 Uint32Array 省内存）。 */
function lcsMatrix(before: string[], after: string[]): Uint32Array {
  const n = before.length;
  const m = after.length;
  const dp = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    const rowBase = i * (m + 1);
    const nextBase = (i + 1) * (m + 1);
    for (let j = m - 1; j >= 0; j--) {
      if (before[i] === after[j]) dp[rowBase + j] = dp[nextBase + j + 1] + 1;
      else dp[rowBase + j] = Math.max(dp[nextBase + j], dp[rowBase + j + 1]);
    }
  }
  return dp;
}

/** 由 LCS 回溯产出对齐的 add/del/ctx 编辑序列。 */
function diffLines(before: string[], after: string[]): Edit[] {
  const n = before.length;
  const m = after.length;
  const dp = lcsMatrix(before, after);
  const edits: Edit[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      edits.push({ type: 'ctx', oldLine: i, newLine: j, content: before[i]! });
      i++;
      j++;
    } else if (dp[(i + 1) * (m + 1) + j] >= dp[i * (m + 1) + j + 1]) {
      edits.push({ type: 'del', oldLine: i, newLine: j, content: before[i]! });
      i++;
    } else {
      edits.push({ type: 'add', oldLine: i, newLine: j, content: after[j]! });
      j++;
    }
  }
  while (i < n) { edits.push({ type: 'del', oldLine: i, newLine: j, content: before[i]! }); i++; }
  while (j < m) { edits.push({ type: 'add', oldLine: i, newLine: j, content: after[j]! }); j++; }
  return edits;
}

/** 把编辑序列按「变更块 + 上下文」切分为 hunks。 */
function buildHunks(edits: Edit[]): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  const n = edits.length;
  let i = 0;
  while (i < n) {
    if (edits[i]!.type === 'ctx') { i++; continue; }

    // 变更块起点，向前扩 CONTEXT 个 ctx 行
    let start = i;
    let ctxBefore = 0;
    while (start - 1 >= 0 && edits[start - 1]!.type === 'ctx' && ctxBefore < CONTEXT) {
      start--;
      ctxBefore++;
    }

    // 向后扫描：变更行持续；ctx 行仅在「间隔 ≤ CONTEXT 且后面仍有变更」时合并，否则作为尾上下文收尾
    let end = i;
    while (end < n) {
      if (edits[end]!.type !== 'ctx') { end++; continue; }
      let look = end;
      let gap = 0;
      while (look < n && edits[look]!.type === 'ctx' && gap < CONTEXT) { look++; gap++; }
      if (look < n && edits[look]!.type !== 'ctx') {
        end = look;
      } else {
        let tail = 0;
        while (end < n && edits[end]!.type === 'ctx' && tail < CONTEXT) { end++; tail++; }
        break;
      }
    }

    const lines: DiffLine[] = [];
    let oldLines = 0;
    let newLines = 0;
    for (let k = start; k < end; k++) {
      const e = edits[k]!;
      lines.push({ type: e.type, content: e.content });
      if (e.type !== 'add') oldLines++;
      if (e.type !== 'del') newLines++;
    }
    const first = edits[start]!;
    hunks.push({
      oldStart: first.oldLine + 1,
      oldLines,
      newStart: first.newLine + 1,
      newLines,
      lines,
    });
    i = end;
  }
  return hunks;
}
