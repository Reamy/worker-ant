/**
 * zx_20261120_1 M4「远·仓」：**任务工作目录**的唯一解析口。
 *
 * 本地任务：与旧行为逐字一致——项目 `working_dir`（空 ⇒ 由调用方回落 `data/projects/<id>`）。
 * 跨机只读任务：`context_json.remote_readonly === true` 且 `remote_workspace` 落在
 *   `.../remote-workspaces/` 根下 ⇒ 用它。**路径围栏**是硬条件：不在根下的一律不认。
 *
 * 为什么收成一处：执行体（`exec-claim`）、验收（`exec-acceptance`）、预读（`memory-manager`）
 *   三处都要回答"这次的活在哪干活"；各写一份就会在远程任务上各说各话。
 */
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { loadProjectBrief } from './project-brief.js';
import type { PreludeProjectContext } from './memory-prelude.js';

export type TaskDirSource = 'remote' | 'project' | 'none';

export interface TaskWorkingDir {
  dir: string;
  source: TaskDirSource;
  reason: string;
}

const REMOTE_SEGMENT = `${path.sep}remote-workspaces${path.sep}`;

/** 路径必须在 `remote-workspaces` 根下（防上下文被塞任意路径）。 */
export function isRemoteWorkspacePath(p: string): boolean {
  const abs = path.resolve(String(p || ''));
  return abs.includes(REMOTE_SEGMENT) && !abs.endsWith(`${path.sep}remote-workspaces`);
}

/** 读模型的一跳：把解析出的目录覆盖到项目上下文副本上（无目录 ⇒ 原样）。 */
export function withResolvedWorkingDir<T extends { working_dir?: string | null }>(
  db: Database.Database,
  taskId: string,
  project: T,
): T {
  const dir = resolveTaskWorkingDir(db, taskId).dir;
  return dir ? { ...project, working_dir: dir } : project;
}

/**
 * 预读用的项目上下文（名称/说明/工作目录/须知一句）：工作目录同样走一处解析；
 * 读不到项目行 ⇒ `undefined`（预读照常，只少这几行）。
 */
export function preludeProjectContext(
  db: Database.Database,
  taskId: string,
  projectId: string,
): PreludeProjectContext | undefined {
  try {
    const row = db.prepare('SELECT name, description, working_dir FROM wa_projects WHERE id = ?').get(projectId) as PreludeProjectContext | undefined;
    if (!row) return undefined;
    const base = withResolvedWorkingDir(db, taskId, row);
    const summary = String(loadProjectBrief(db, projectId)?.brief?.summary ?? '').trim().slice(0, 200);
    return summary ? { ...base, brief_summary: summary } : base;
  } catch { return undefined; }
}

export function resolveTaskWorkingDir(db: Database.Database, taskId: string): TaskWorkingDir {
  let ctx: Record<string, unknown> = {};
  let projectDir = '';
  try {
    const row = db.prepare(
      `SELECT t.context_json AS ctx, p.working_dir AS working_dir
         FROM wa_tasks t LEFT JOIN wa_projects p ON p.id = t.project_id
        WHERE t.id = ?`,
    ).get(taskId) as { ctx?: string | null; working_dir?: string | null } | undefined;
    try { ctx = JSON.parse(String(row?.ctx ?? '{}')) as Record<string, unknown>; } catch { ctx = {}; }
    projectDir = String(row?.working_dir ?? '').trim();
  } catch {
    return { dir: '', source: 'none', reason: 'task_unreadable' };
  }
  if (ctx.remote_readonly === true) {
    const ws = typeof ctx.remote_workspace === 'string' ? ctx.remote_workspace : '';
    if (!isRemoteWorkspacePath(ws)) return { dir: '', source: 'none', reason: 'remote_workspace_outside_root' };
    if (!fs.existsSync(ws)) return { dir: '', source: 'none', reason: 'remote_workspace_missing' };
    return { dir: path.resolve(ws), source: 'remote', reason: '' };
  }
  if (projectDir) return { dir: projectDir, source: 'project', reason: '' };
  return { dir: '', source: 'none', reason: 'no_working_dir' };
}
