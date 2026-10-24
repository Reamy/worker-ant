/**
 * zx_20261022_3 批十二（信·名实）：**任务自有文件账** —— "这行脏是谁写的"必须有一本账。
 *
 * 病根（真标本 094a8b47 / e54532f9）：finalize 提交闸按**整仓** `git status --porcelain` 判——
 *   多任务并行共写一树时，A 任务会被 B 任务的 64 项未提交改动拦住；而它既没 shell 也无从归属，
 *   于是"要求提交"这一条**永远无法满足**。本账记 write_file/edit_file 落过的绝对路径，
 *   提交闸只认本任务写过/登记的路径（交付物表仍并集，覆盖子进程落盘后人工登记的文件）。
 *
 * 单一读面：`ownedPaths`。写口只在 `tools/write.ts` 两个工具成功后各调一次 `recordTaskFile`。
 */
import path from 'node:path';
import fs from 'node:fs';
import type Database from 'better-sqlite3';
import { runShellCommand } from './shell-exec.js';

/** 记一笔自有文件（幂等：同任务同路径只更新时间与来源）。 */
export function recordTaskFile(db: Database.Database, taskId: string, absPath: string, via: string): void {
  try {
    const p = path.resolve(absPath);
    db.prepare(
      `INSERT INTO wa_task_files (task_id, path, via) VALUES (?, ?, ?)
       ON CONFLICT(task_id, path) DO UPDATE SET via = excluded.via, last_at = datetime('now')`,
    ).run(taskId, p, via);
  } catch {
    /* 记账失败不阻断写入：文件已落盘，闸门缺账时按"无法归属"如实降级（warn） */
  }
}

/** 本任务写过（账）∪ 已登记交付物（表）的绝对路径，去重、保序。 */
export function ownedPaths(db: Database.Database, taskId: string): string[] {
  const out = new Set<string>();
  try {
    const rows = db.prepare('SELECT path FROM wa_task_files WHERE task_id = ?').all(taskId) as Array<{ path: string }>;
    for (const r of rows) if (r.path) out.add(path.resolve(r.path));
  } catch { /* 老库无表 ⇒ 空账 */ }
  try {
    const rows = db.prepare('SELECT file_path FROM wa_deliverables WHERE task_id = ? AND file_path IS NOT NULL').all(taskId) as Array<{ file_path: string }>;
    for (const r of rows) if (r.file_path) out.add(path.resolve(r.file_path));
  } catch { /* 查询失败按无登记 */ }
  return [...out];
}

/** `git status --porcelain` 的一行 → 该行涉及的仓内相对路径（含重命名的两端）。 */
export function porcelainPaths(line: string): string[] {
  const body = line.slice(3).trim();
  if (!body) return [];
  const arrow = body.split(' -> ');
  return arrow.map((s) => s.replace(/^"|"$/g, '').trim()).filter(Boolean);
}

/** 该行是否落在自有路径集内（按仓根解析后比较，避免 `/a/./b` 与 `/a/b` 两说）。 */
export function lineIsOwned(root: string, line: string, ownedAbs: ReadonlySet<string>): boolean {
  return porcelainPaths(line).some((rel) => ownedAbs.has(path.resolve(root, rel)));
}

/** 自某文件上溯找 `.git`（目录即仓根）；找不到返回 null。 */
export function gitRootOf(absPath: string): string | null {
  let dir = path.dirname(path.resolve(absPath));
  for (let i = 0; i < 40; i++) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/**
 * zx_20261022_3 批十二（毛选·没有调查就没有发言权）：给**验收判卷**补只读的执行面证据。
 *
 * 判卷器是一发 LLM（`checkAcceptanceCriteria`），此前只看会话/交付摘录，DoD 里那些
 * "node --check / BUILD SUCCESS / 行数 / 未提交"的条目它**无从核实**。这里由引擎**只读**执行
 * `git status`/`git diff --stat`（范围严格限本任务自有文件），把真实仓库状态交给判卷器。
 * 失败/超时一律返回空串——判卷不因取证失败而卡死或冒充通过。
 */
export async function renderOwnedRepoEvidence(db: Database.Database, taskId: string): Promise<string> {
  const owned = ownedPaths(db, taskId);
  if (owned.length === 0) return '';
  const byRoot = new Map<string, string[]>();
  for (const p of owned.slice(0, 60)) {
    const root = gitRootOf(p);
    if (!root) continue;
    const arr = byRoot.get(root) ?? [];
    arr.push(path.relative(root, p));
    byRoot.set(root, arr);
  }
  const parts: string[] = [];
  for (const [root, files] of byRoot) {
    const quoted = files.map((f) => `"${f}"`).join(' ');
    try {
      const st = await runShellCommand(`git status --porcelain -- ${quoted}`, { cwd: root, timeoutMs: 8_000, maxBuffer: 512 * 1024 });
      const df = await runShellCommand(`git diff --stat -- ${quoted}`, { cwd: root, timeoutMs: 8_000, maxBuffer: 512 * 1024 });
      parts.push(
        `仓库 ${root}\n· 自有文件（${files.length}）：${files.slice(0, 20).join('、')}${files.length > 20 ? ' 等' : ''}`
        + `\n· git status：${st.ok && st.stdout.trim() ? st.stdout.trim() : '（无未提交改动）'}`
        + `\n· git diff --stat：${df.ok && df.stdout.trim() ? df.stdout.trim() : '（无差异）'}`,
      );
    } catch { /* 取证失败不留假证据 */ }
  }
  return parts.join('\n\n').slice(0, 4000);
}

export interface GitGateInput {
  /** 题面是否要求提交（title+description 命中 提交|commit|git） */
  mentionsGit: boolean;
  /** 本形态工具面是否含 shell（无 shell ⇒ 无论多脏都只能警示） */
  hasShell: boolean;
  /** 本任务自有绝对路径集（`ownedPaths`） */
  owned: readonly string[];
  /** 逐仓 porcelain 行 */
  dirt: ReadonlyArray<{ root: string; lines: readonly string[] }>;
}

export interface GitGateVerdict {
  mode: 'pass' | 'warn' | 'block';
  /** 本任务自己的未提交路径（绝对） */
  ownedDirty: string[];
  reason: string;
}

/**
 * 提交闸判据（**纯函数**，rr 直跑真实现）。
 * - 未要求提交 ⇒ pass；
 * - 有 shell 且自有路径脏 ⇒ block（只点自己的文件，不再拿他人改动说事）；
 * - 有 shell 且他人脏/自身干净 ⇒ pass；
 * - 无 shell ⇒ warn（拦也没用：给不了执行面，硬拦等于死锁，真标本 094a8b47 的循环）；
 * - 自有路径**一无所知** ⇒ warn（"无法归属"不能说成"你脏了"）。
 */
export function gitGateVerdict(input: GitGateInput): GitGateVerdict {
  if (!input.mentionsGit) return { mode: 'pass', ownedDirty: [], reason: '题面未要求提交' };
  const ownedAbs = new Set(input.owned.map((p) => path.resolve(p)));
  const ownedDirty = new Set<string>();
  for (const d of input.dirt) {
    for (const line of d.lines) {
      for (const rel of porcelainPaths(line)) {
        const abs = path.resolve(d.root, rel);
        if (ownedAbs.has(abs)) ownedDirty.add(abs);
      }
    }
  }
  const list = [...ownedDirty];
  if (!input.hasShell) {
    return { mode: 'warn', ownedDirty: list, reason: '本任务形态无 shell 工具面——提交无法由执行体完成，降级为警示' };
  }
  if (input.owned.length === 0) {
    return { mode: 'warn', ownedDirty: list, reason: '本任务无自有文件账（未 write_file/登记交付物），无法按路径归属提交' };
  }
  if (list.length > 0) {
    return { mode: 'block', ownedDirty: list, reason: `本任务自有 ${list.length} 个文件未提交` };
  }
  return { mode: 'pass', ownedDirty: [], reason: '本任务自有文件均已提交（工作树中的其他改动不属于本任务）' };
}
